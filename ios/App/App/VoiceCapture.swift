import Foundation
import Capacitor
import AVFoundation

// Native microphone capture for the voice coach. The WebView's getUserMedia is
// silent on iOS, so we capture natively. Critically, this uses a CONTINUOUS
// AVAudioEngine input tap that never stops while the coach is active — that keeps
// live audio input running, so iOS (with the "audio" background mode) keeps the
// app alive when the screen turns off, instead of suspending it between phrases.
//
// Flow: configure() sets up the session + starts the engine. listen() begins
// detecting a phrase; on end-of-phrase (energy VAD → ~0.6s silence) we transcribe
// the buffered audio natively (URLSession → OpenAI, no WebView CORS) and emit the
// TEXT to JS, then stop detecting until JS calls listen() again. pause()/resume()
// gate detection during the coach's own speech. The engine keeps running throughout.
@objc(VoiceCapturePlugin)
public class VoiceCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceCapturePlugin"
    public let jsName = "VoiceCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AVAudioEngine()
    private var engineRunning = false
    private var openaiKey = ""

    // Detection state (touched on the audio thread; guarded by `lock`).
    private let lock = NSLock()
    private var detecting = false
    private var inSpeech = false
    private var speechSamples = 0
    private var silenceSamples = 0
    private var phrase = Data()           // 16-bit PCM mono for the current phrase
    private var phraseRate: Double = 16000
    private var levelThrottle = 0
    private var lastBufferAt: Double = 0  // systemUptime of the last tap callback (staleness check)
    private var observersOn = false

    // Tuning
    private let speechDb: Float = -40.0    // dBFS above which we treat audio as speech
    private let silenceSecs = 0.6          // trailing silence that ends a phrase
    private let minSpeechSecs = 0.2

    // MARK: - Public API

    @objc func configure(_ call: CAPPluginCall) {
        if let k = call.getString("openaiKey"), !k.isEmpty { openaiKey = k }
        let session = AVAudioSession.sharedInstance()
        func setupAndResolve() {
            do {
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
                try session.setActive(true)
            } catch { print("[VoiceCapture] session error: \(error)") }
            do { try session.overrideOutputAudioPort(.speaker) } catch { print("[VoiceCapture] speaker error: \(error)") }
            self.registerSessionObservers()
            self.startEngine()
            call.resolve()
        }
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: setupAndResolve()
            case .denied: call.reject("permission-denied")
            default: AVAudioApplication.requestRecordPermission { ok in
                DispatchQueue.main.async { ok ? setupAndResolve() : call.reject("permission-denied") } }
            }
        } else {
            switch session.recordPermission {
            case .granted: setupAndResolve()
            case .denied: call.reject("permission-denied")
            default: session.requestRecordPermission { ok in
                DispatchQueue.main.async { ok ? setupAndResolve() : call.reject("permission-denied") } }
            }
        }
    }

    @objc func listen(_ call: CAPPluginCall) {
        ensureEngineRunning()
        beginPhrase()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        lock.lock(); detecting = false; lock.unlock()
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) {
        ensureEngineRunning()
        beginPhrase()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        lock.lock(); detecting = false; lock.unlock()
        if engineRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            engineRunning = false
        }
        call.resolve()
    }

    // MARK: - Engine

    private func beginPhrase() {
        lock.lock()
        detecting = true; inSpeech = false; speechSamples = 0; silenceSamples = 0; phrase = Data()
        lock.unlock()
    }

    private func startEngine() {
        guard !engineRunning else { return }
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.channelCount > 0, fmt.sampleRate > 0 else {
            print("[VoiceCapture] invalid input format \(fmt)"); return
        }
        phraseRate = fmt.sampleRate
        let channels = Int(fmt.channelCount)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buffer, _ in
            self?.process(buffer, channels: channels)
        }
        engine.prepare()
        do { try engine.start(); engineRunning = true; lastBufferAt = ProcessInfo.processInfo.systemUptime }
        catch { print("[VoiceCapture] engine start error: \(error)") }
    }

    // The AVAudioEngine input tap can silently stop after TTS playback or a route
    // change (engine.isRunning may even still read true while no buffers arrive).
    // So re-assert the session and FULLY rebuild the engine whenever it isn't
    // running OR no buffer has arrived recently. Called on every listen()/resume()
    // (incl. the JS watchdog's restarts) and on interruption/route-change events.
    private func ensureEngineRunning() {
        let session = AVAudioSession.sharedInstance()
        do {
            if session.category != .playAndRecord {
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            }
            try session.setActive(true)
        } catch { print("[VoiceCapture] ensure session error: \(error)") }
        try? session.overrideOutputAudioPort(.speaker)

        let stale = (ProcessInfo.processInfo.systemUptime - lastBufferAt) > 0.8
        if engine.isRunning && !stale { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine.reset()
        engineRunning = false
        startEngine()
    }

    private func registerSessionObservers() {
        guard !observersOn else { return }
        observersOn = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
    }
    @objc private func handleInterruption(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended { DispatchQueue.main.async { self.ensureEngineRunning() } }
    }
    @objc private func handleRouteChange(_ n: Notification) {
        DispatchQueue.main.async { self.ensureEngineRunning() }
    }

    private func process(_ buffer: AVAudioPCMBuffer, channels: Int) {
        lastBufferAt = ProcessInfo.processInfo.systemUptime
        guard let chans = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        if frames == 0 { return }

        // Downmix to mono, compute RMS, build 16-bit PCM.
        var sumSq: Float = 0
        var pcm = Data(capacity: frames * 2)
        for i in 0..<frames {
            var s: Float = 0
            for c in 0..<channels { s += chans[c][i] }
            s /= Float(channels)
            sumSq += s * s
            let clamped = max(-1.0, min(1.0, s))
            var le = Int16(clamped * 32767).littleEndian
            withUnsafeBytes(of: &le) { pcm.append(contentsOf: $0) }
        }
        let rms = sqrt(sumSq / Float(frames))
        let db = 20 * log10(max(rms, 1e-7))

        // Throttled level for the on-screen meter.
        levelThrottle += 1
        if levelThrottle % 3 == 0 {
            let level = max(0.0, min(100.0, (Double(db) + 60.0) / 60.0 * 100.0))
            DispatchQueue.main.async { self.notifyListeners("level", data: ["level": level]) }
        }

        lock.lock()
        guard detecting else { lock.unlock(); return }
        let speaking = db > speechDb
        if speaking {
            inSpeech = true; speechSamples += frames; silenceSamples = 0
            phrase.append(pcm)
        } else if inSpeech {
            silenceSamples += frames
            phrase.append(pcm)
        }
        let endOfPhrase = inSpeech
            && silenceSamples >= Int(silenceSecs * phraseRate)
            && speechSamples >= Int(minSpeechSecs * phraseRate)
        if endOfPhrase {
            let wav = wrapWav(phrase, sampleRate: phraseRate)
            detecting = false; inSpeech = false; phrase = Data()
            lock.unlock()
            transcribe(wav)
        } else {
            lock.unlock()
        }
    }

    // MARK: - Native transcription (no WebView / no CORS)

    private func transcribe(_ wav: Data) {
        guard !openaiKey.isEmpty else { notifyListeners("empty", data: ["error": "no key"]); return }
        var req = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/transcriptions")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer \(openaiKey)", forHTTPHeaderField: "Authorization")
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        field("model", "gpt-4o-mini-transcribe")
        field("language", "en")
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wav)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err { self.notifyListeners("empty", data: ["error": "net: \(err.localizedDescription)"]); return }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = json["text"] as? String {
                self.notifyListeners("utterance", data: ["text": text])
            } else {
                let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.notifyListeners("empty", data: ["error": "http \(status): \(String(body.prefix(140)))"])
            }
        }.resume()
    }

    private func wrapWav(_ pcm: Data, sampleRate: Double) -> Data {
        let dataSize = pcm.count
        var d = Data()
        func a(_ s: String) { d.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        a("RIFF"); u32(UInt32(36 + dataSize)); a("WAVE")
        a("fmt "); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate) * 2); u16(2); u16(16)
        a("data"); u32(UInt32(dataSize))
        d.append(pcm)
        return d
    }
}
