import Foundation
import Capacitor
import AVFoundation
import UIKit

// Native microphone capture for the voice coach. The WebView's getUserMedia is
// unreliable/silent on iOS, so we capture audio natively with AVAudioRecorder,
// do simple energy-based voice-activity detection, and hand each finished phrase
// back to JS as a base64 m4a clip (which JS sends to Whisper exactly as before).
// We also force the audio session to the SPEAKER and pair it with the "audio"
// background mode so it keeps listening with the screen off.
@objc(VoiceCapturePlugin)
public class VoiceCapturePlugin: CAPPlugin, CAPBridgedPlugin, AVAudioRecorderDelegate {
    public let identifier = "VoiceCapturePlugin"
    public let jsName = "VoiceCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
    ]

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var fileURL: URL?
    private var capturing = false
    private var openaiKey = ""   // passed from JS; used for native (CORS-free) transcription
    private var cartesiaKey = "" // passed from JS; used when provider == "cartesia"
    private var xaiKey = ""       // passed from JS; used when provider == "grok"
    private var provider = "legacy"   // "legacy" (OpenAI Whisper) | "cartesia" (Ink-Whisper) | "grok" (Grok STT)
    private var keepAlive: AVAudioPlayer?   // looping silent audio → keeps the app alive with the screen off

    // ── Streaming TTS (Grok WebSocket → AVAudioEngine progressive playback) ──
    // The browser WebSocket API can't set the Authorization header Grok requires, so
    // streaming TTS runs here in native code: open a WS, push the text, and play the
    // base64 PCM audio chunks as they stream back — first audio in ~0.5s instead of
    // waiting ~2.3s for the whole clip.
    private let ttsEngine = AVAudioEngine()
    private let ttsPlayer = AVAudioPlayerNode()
    private var ttsFormat: AVAudioFormat?
    private var ttsEngineReady = false
    private var ttsWS: URLSessionWebSocketTask?
    private var ttsURLSession: URLSession?
    private var ttsScheduled = 0
    private var ttsCompleted = 0
    private var ttsStreamDone = false
    private var ttsActive = false
    private var hasSpeech = false
    private var speechFrames = 0
    private var silenceFrames = 0
    private var totalFrames = 0

    // Tuning (frames are ~100ms each via the meter timer).
    private let speechThreshold: Float = -38.0   // dBFS above which we treat sound as speech
    private let silenceHang = 5                   // ~0.5s of silence ends a phrase (snappy but won't cut you off)
    private let minSpeechFrames = 2               // need ~0.2s of speech to count as real
    private let maxFrames = 120                   // ~12s hard cap per phrase
    private let idleFrames = 50                   // ~5s of no speech → give up, return empty

    // Configure + activate the audio session (record + playback, forced to speaker)
    // and ask for mic permission. Call once when the coach session starts.
    @objc func configure(_ call: CAPPluginCall) {
        if let k = call.getString("openaiKey"), !k.isEmpty { openaiKey = k }
        if let k = call.getString("cartesiaKey"), !k.isEmpty { cartesiaKey = k }
        if let k = call.getString("xaiKey"), !k.isEmpty { xaiKey = k }
        if let p = call.getString("provider"), !p.isEmpty { provider = p.lowercased() }
        let session = AVAudioSession.sharedInstance()
        // Set up the session BEST-EFFORT: recording works even if a routing call
        // throws, so we only fail when the mic permission is actually denied.
        func setupSessionAndResolve() {
            do {
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
                try session.setActive(true)
            } catch { print("[VoiceCapture] setCategory error: \(error)") }
            self.applyOutputRoute()
            self.startKeepAlive()
            // Keep the screen awake while the coach is active so iOS doesn't auto-lock
            // mid-workout (which suspends the web layer and stops the conversation). A
            // deliberate lock by the user still stops it, as expected.
            // MUST be on the main thread — this is a UIKit call and configure() can run
            // on a background queue (setting it off-main froze the app).
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
            call.resolve()
        }
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: setupSessionAndResolve()
            case .denied: call.reject("permission-denied")
            default:
                AVAudioApplication.requestRecordPermission { granted in
                    DispatchQueue.main.async { granted ? setupSessionAndResolve() : call.reject("permission-denied") }
                }
            }
        } else {
            switch session.recordPermission {
            case .granted: setupSessionAndResolve()
            case .denied: call.reject("permission-denied")
            default:
                session.requestRecordPermission { granted in
                    DispatchQueue.main.async { granted ? setupSessionAndResolve() : call.reject("permission-denied") }
                }
            }
        }
    }

    // Capture ONE phrase, then emit a `utterance` event with the audio (or an
    // `empty` event if nothing was said). JS calls this at the start of each turn.
    @objc func listen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.beginRecording()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endRecording(emit: false)
            self.stopTTSInternal()
            self.stopKeepAlive()
            UIApplication.shared.isIdleTimerDisabled = false   // restore normal auto-lock
            call.resolve()
        }
    }

    // MARK: - Streaming TTS (Grok WebSocket → progressive AVAudioEngine playback)

    @objc func speak(_ call: CAPPluginCall) {
        let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let voice = call.getString("voiceId") ?? "eve"
        let speed = max(0.7, min(1.5, call.getDouble("speed") ?? 1.0))   // Grok allows 0.7–1.5
        guard !xaiKey.isEmpty else { notifyListeners("speakDone", data: ["error": "no key"]); call.resolve(); return }
        guard !text.isEmpty else { notifyListeners("speakDone", data: [:]); call.resolve(); return }
        DispatchQueue.main.async {
            self.startTTS(text: text, voice: voice, speed: speed)
            call.resolve()
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.stopTTSInternal() }
        call.resolve()
    }

    private func setupTTSEngine() {
        if ttsEngineReady { return }
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)
        ttsFormat = fmt
        ttsEngine.attach(ttsPlayer)
        ttsEngine.connect(ttsPlayer, to: ttsEngine.mainMixerNode, format: fmt)
        ttsEngine.prepare()
        ttsEngineReady = true
    }

    private func startTTS(text: String, voice: String, speed: Double) {
        stopTTSInternal()
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        applyOutputRoute()                       // keep playback on speaker / earbuds
        setupTTSEngine()
        ttsScheduled = 0; ttsCompleted = 0; ttsStreamDone = false; ttsActive = true

        var comps = URLComponents(string: "wss://api.x.ai/v1/tts")!
        comps.queryItems = [
            URLQueryItem(name: "language", value: "en"),
            URLQueryItem(name: "voice", value: voice),
            URLQueryItem(name: "codec", value: "pcm"),
            URLQueryItem(name: "sample_rate", value: "24000"),
            URLQueryItem(name: "optimize_streaming_latency", value: "2"),
            URLQueryItem(name: "speed", value: String(format: "%.2f", speed)),
        ]
        guard let url = comps.url else { finishTTS(error: "bad url"); return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(xaiKey)", forHTTPHeaderField: "Authorization")
        let s = URLSession(configuration: .default)
        ttsURLSession = s
        let ws = s.webSocketTask(with: req)
        ttsWS = ws
        ws.resume()

        if let msg = try? JSONSerialization.data(withJSONObject: ["type": "text.delta", "delta": text]),
           let str = String(data: msg, encoding: .utf8) {
            ws.send(.string(str)) { _ in }
        }
        ws.send(.string("{\"type\":\"text.done\"}")) { _ in }
        receiveTTS()
    }

    private func receiveTTS() {
        guard let ws = ttsWS else { return }
        ws.receive { [weak self] result in
            guard let self = self, self.ttsActive else { return }
            switch result {
            case .failure(let err):
                DispatchQueue.main.async { self.finishTTS(error: "ws: \(err.localizedDescription)") }
            case .success(let msg):
                switch msg {
                case .string(let str): self.handleTTSMessage(str)
                case .data(let d): if let str = String(data: d, encoding: .utf8) { self.handleTTSMessage(str) }
                @unknown default: break
                }
                self.receiveTTS()
            }
        }
    }

    private func handleTTSMessage(_ str: String) {
        guard let data = str.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "audio.delta":
            if let b64 = obj["delta"] as? String, let pcm = Data(base64Encoded: b64) { scheduleTTSAudio(pcm) }
        case "audio.done":
            DispatchQueue.main.async { self.ttsStreamDone = true; self.checkTTSComplete() }
        case "error":
            DispatchQueue.main.async { self.finishTTS(error: (obj["message"] as? String) ?? "tts error") }
        default: break
        }
    }

    private func scheduleTTSAudio(_ pcm: Data) {
        guard let fmt = ttsFormat else { return }
        let frames = pcm.count / 2   // 16-bit LE samples
        if frames == 0 { return }
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let samples = raw.bindMemory(to: Int16.self)
            if let ch = buf.floatChannelData {
                for i in 0..<frames {
                    ch[0][i] = max(-1.0, min(1.0, Float(Int16(littleEndian: samples[i])) / 32768.0))
                }
            }
        }
        DispatchQueue.main.async {
            guard self.ttsActive else { return }
            if !self.ttsEngine.isRunning { try? self.ttsEngine.start() }
            if !self.ttsPlayer.isPlaying { self.ttsPlayer.play() }
            self.ttsScheduled += 1
            self.ttsPlayer.scheduleBuffer(buf) {
                DispatchQueue.main.async { self.ttsCompleted += 1; self.checkTTSComplete() }
            }
        }
    }

    private func checkTTSComplete() {
        if ttsActive && ttsStreamDone && ttsCompleted >= ttsScheduled { finishTTS(error: nil) }
    }

    private func finishTTS(error: String?) {
        guard ttsActive else { return }
        if let error = error { print("[VoiceCapture] TTS: \(error)") }
        let hadError = error != nil
        stopTTSInternal()
        notifyListeners("speakDone", data: hadError ? ["error": error!] : [:])
    }

    private func stopTTSInternal() {
        ttsActive = false
        ttsWS?.cancel(with: .goingAway, reason: nil); ttsWS = nil
        ttsURLSession?.invalidateAndCancel(); ttsURLSession = nil
        if ttsPlayer.isPlaying { ttsPlayer.stop() }
        if ttsEngine.isRunning { ttsEngine.stop() }
    }

    // Loop silent audio so the app keeps "producing audio" — with the UIBackgroundModes
    // "audio" entitlement, iOS then keeps the app (and our listen loop) alive when the
    // screen turns off, instead of suspending it between recording bursts.
    private func startKeepAlive() {
        guard keepAlive == nil else { return }
        if let player = try? AVAudioPlayer(data: makeSilentWav()) {
            player.numberOfLoops = -1
            player.volume = 0.0
            player.play()
            keepAlive = player
        }
    }
    private func stopKeepAlive() {
        keepAlive?.stop()
        keepAlive = nil
    }
    private func makeSilentWav(seconds: Double = 2.0, sampleRate: Double = 8000) -> Data {
        let numSamples = Int(seconds * sampleRate)
        let dataSize = numSamples * 2   // 16-bit mono
        var d = Data()
        func a(_ s: String) { d.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        a("RIFF"); u32(UInt32(36 + dataSize)); a("WAVE")
        a("fmt "); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate) * 2); u16(2); u16(16)
        a("data"); u32(UInt32(dataSize))
        d.append(Data(count: dataSize))   // all zeros = silence
        return d
    }

    // Route audio to connected earbuds/Bluetooth/headphones when present (the gym
    // case: coach in your ear, mic from the earbud). Only force the loud speaker on
    // a bare phone — never the quiet earpiece.
    private func applyOutputRoute() {
        let session = AVAudioSession.sharedInstance()
        // Clear any prior forced-speaker override FIRST, otherwise a newly-connected
        // headset stays masked (currentRoute keeps reporting the speaker) and audio
        // won't switch to the earbuds mid-session.
        try? session.overrideOutputAudioPort(.none)
        let external: Set<AVAudioSession.Port> = [
            .headphones, .headsetMic, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio, .usbAudio
        ]
        let hasExternal = session.currentRoute.outputs.contains { external.contains($0.portType) }
        if !hasExternal { try? session.overrideOutputAudioPort(.speaker) }
    }

    private func beginRecording() {
        endRecording(emit: false)   // ensure clean state
        // Re-assert the route each turn (WebKit/interruptions can change it).
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        applyOutputRoute()

        hasSpeech = false; speechFrames = 0; silenceFrames = 0; totalFrames = 0
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vc-\(UUID().uuidString).m4a")
        fileURL = url
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        do {
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.isMeteringEnabled = true
            r.delegate = self
            r.record()
            recorder = r
            capturing = true
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                self?.tick()
            }
        } catch {
            notifyListeners("empty", data: [:])
        }
    }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        let power = r.averagePower(forChannel: 0)   // ~ -160 (silent) … 0 (loud)
        // Surface a 0–100 level for the on-screen meter.
        let level = max(0.0, min(100.0, (power + 60.0) / 60.0 * 100.0))
        notifyListeners("level", data: ["level": level])

        totalFrames += 1
        if power > speechThreshold {
            hasSpeech = true; speechFrames += 1; silenceFrames = 0
        } else if hasSpeech {
            silenceFrames += 1
        }

        if hasSpeech && silenceFrames >= silenceHang && speechFrames >= minSpeechFrames {
            endRecording(emit: true)            // natural end of phrase
        } else if totalFrames >= maxFrames {
            endRecording(emit: hasSpeech)       // hard cap
        } else if !hasSpeech && totalFrames >= idleFrames {
            endRecording(emit: false)           // nobody spoke → empty
        }
    }

    private func endRecording(emit: Bool) {
        meterTimer?.invalidate(); meterTimer = nil
        let r = recorder; recorder = nil
        let url = fileURL
        let didSpeak = hasSpeech
        capturing = false
        r?.stop()

        if emit && didSpeak, let url = url,
           let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int, size > 1200 {
            transcribe(url)          // native transcription → emits `utterance` {text} (removes file)
        } else if emit {
            if let url = url { try? FileManager.default.removeItem(at: url) }
            notifyListeners("empty", data: [:])
        } else if let url = url {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // Transcribe the recorded clip natively via URLSession (no WebView / no CORS),
    // then emit the resulting TEXT to JS. Routes to Cartesia (Ink-Whisper) or OpenAI
    // (Whisper) based on the provider passed from JS — both return JSON {"text": ...}.
    private func transcribe(_ url: URL) {
        let useGrok = (provider == "grok") && !xaiKey.isEmpty
        let useCartesia = (provider == "cartesia") && !cartesiaKey.isEmpty
        let key = useGrok ? xaiKey : (useCartesia ? cartesiaKey : openaiKey)
        guard !key.isEmpty else {
            try? FileManager.default.removeItem(at: url)
            notifyListeners("empty", data: ["error": "no key"]); return
        }
        let endpoint = useGrok ? "https://api.x.ai/v1/stt"
                     : useCartesia ? "https://api.cartesia.ai/stt"
                     : "https://api.openai.com/v1/audio/transcriptions"
        var req = URLRequest(url: URL(string: endpoint)!)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if useCartesia { req.setValue("2026-03-01", forHTTPHeaderField: "Cartesia-Version") }
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        if !useGrok {   // Grok /stt infers the model; OpenAI + Cartesia need it specified
            field("model", useCartesia ? "ink-whisper" : "gpt-4o-mini-transcribe")
            field("language", "en")
        }
        if let fileData = try? Data(contentsOf: url) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.m4a\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: audio/m4a\r\n\r\n".data(using: .utf8)!)
            body.append(fileData)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        try? FileManager.default.removeItem(at: url)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err {
                self.notifyListeners("empty", data: ["error": "net: \(err.localizedDescription)"]); return
            }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = json["text"] as? String {
                self.notifyListeners("utterance", data: ["text": text])
            } else {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.notifyListeners("empty", data: ["error": "http \(status): \(String(bodyStr.prefix(140)))"])
            }
        }.resume()
    }
}
