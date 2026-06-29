import Foundation
import Capacitor
import AVFoundation

// Native microphone capture for the voice coach. The WebView's getUserMedia is
// unreliable/silent on iOS, so we capture natively with AVAudioRecorder + energy
// VAD and transcribe each finished phrase natively (URLSession → OpenAI, no
// WebView CORS), handing the TEXT back to JS.
//
// Screen-off: a recorder is kept running CONTINUOUSLY the whole session — we never
// leave the mic idle. When a phrase ends we instantly swap to a fresh recorder
// (sub-ms gap) rather than stopping. Because real audio INPUT is always active,
// iOS (with the "audio" background mode) keeps the app — and its meter timer —
// alive when the screen turns off. (A continuously *recording* mic is recognized
// as active audio; looping silent *playback* is not, which is why that failed.)
@objc(VoiceCapturePlugin)
public class VoiceCapturePlugin: CAPPlugin, CAPBridgedPlugin, AVAudioRecorderDelegate {
    public let identifier = "VoiceCapturePlugin"
    public let jsName = "VoiceCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var fileURL: URL?
    private var openaiKey = ""
    private var active = false       // session running → keep a recorder alive
    private var detecting = false    // actively looking for a phrase (false during TTS/processing)

    private var hasSpeech = false
    private var speechFrames = 0
    private var silenceFrames = 0
    private var totalFrames = 0
    private var idleFramesCount = 0  // frames recorded while NOT detecting (bounds keepalive file)

    // Tuning (frames are ~100ms each via the meter timer).
    private let speechThreshold: Float = -38.0   // dBFS above which sound counts as speech
    private let silenceHang = 6                   // ~0.6s of silence ends a phrase
    private let minSpeechFrames = 2               // need ~0.2s of speech to count as real
    private let maxFrames = 120                   // ~12s hard cap per phrase
    private let idleGiveUp = 80                   // ~8s of no speech while detecting → empty
    private let keepaliveRestart = 100            // ~10s → recycle the idle keepalive file

    private let recSettings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 16000,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
    ]

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
            self.active = true
            self.detecting = false
            self.swapRecorder()        // start the continuous (keepalive) recorder
            self.startTimer()
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
        DispatchQueue.main.async {
            if !self.active {        // re-arm if a previous stop() tore things down
                self.active = true
                self.reassertSession()
                self.startTimer()
            }
            self.reassertSession()
            self.detecting = true
            if let old = self.swapRecorder() { try? FileManager.default.removeItem(at: old) } // fresh phrase
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.active = false
            self.detecting = false
            self.meterTimer?.invalidate(); self.meterTimer = nil
            self.recorder?.stop(); self.recorder = nil
            if let url = self.fileURL { try? FileManager.default.removeItem(at: url) }
            call.resolve()
        }
    }

    // MARK: - Recording

    private func reassertSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        try? session.overrideOutputAudioPort(.speaker)
    }

    private func startTimer() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    }

    // Stop the current recorder (returning its file, NOT deleted) and immediately
    // start a fresh one — so the mic input never goes idle. Resets VAD counters.
    @discardableResult
    private func swapRecorder() -> URL? {
        let oldURL = fileURL
        recorder?.stop()
        hasSpeech = false; speechFrames = 0; silenceFrames = 0; totalFrames = 0; idleFramesCount = 0
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vc-\(UUID().uuidString).m4a")
        fileURL = url
        do {
            let r = try AVAudioRecorder(url: url, settings: recSettings)
            r.isMeteringEnabled = true
            r.delegate = self
            r.record()
            recorder = r
        } catch {
            recorder = nil
            print("[VoiceCapture] recorder error: \(error)")
        }
        return oldURL
    }

    private func tick() {
        guard active else { return }
        guard let r = recorder, r.isRecording else {
            swapRecorder()   // recorder died → restart to keep the mic alive
            return
        }
        r.updateMeters()
        let power = r.averagePower(forChannel: 0)   // ~ -160 (silent) … 0 (loud)
        let level = max(0.0, min(100.0, (Double(power) + 60.0) / 60.0 * 100.0))
        notifyListeners("level", data: ["level": level])

        if !detecting {
            // Keepalive only: keep recording, recycle the file periodically.
            idleFramesCount += 1
            if idleFramesCount >= keepaliveRestart { if let u = swapRecorder() { try? FileManager.default.removeItem(at: u) } }
            return
        }

        totalFrames += 1
        if power > speechThreshold {
            hasSpeech = true; speechFrames += 1; silenceFrames = 0
        } else if hasSpeech {
            silenceFrames += 1
        }

        if hasSpeech && silenceFrames >= silenceHang && speechFrames >= minSpeechFrames {
            endPhrase(emit: true)
        } else if totalFrames >= maxFrames {
            endPhrase(emit: hasSpeech)
        } else if !hasSpeech && totalFrames >= idleGiveUp {
            endPhrase(emit: false)
        }
    }

    // A phrase finished. Swap to a fresh keepalive recorder (mic stays live), then
    // transcribe the captured phrase file (or emit empty).
    private func endPhrase(emit: Bool) {
        let didSpeak = hasSpeech
        detecting = false
        let url = swapRecorder()   // returns the just-finished phrase file; new recorder now running
        guard let url = url else { if emit { notifyListeners("empty", data: [:]) }; return }
        if emit && didSpeak,
           let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int, size > 1200 {
            transcribe(url)
        } else {
            try? FileManager.default.removeItem(at: url)
            if emit { notifyListeners("empty", data: [:]) }
        }
    }

    // MARK: - Native transcription (no WebView / no CORS)

    private func transcribe(_ url: URL) {
        guard !openaiKey.isEmpty else {
            try? FileManager.default.removeItem(at: url)
            notifyListeners("empty", data: ["error": "no key"]); return
        }
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
            if let err = err { self.notifyListeners("empty", data: ["error": "net: \(err.localizedDescription)"]); return }
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
