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
    ]

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var fileURL: URL?
    private var capturing = false
    private var openaiKey = ""   // passed from JS; used for native (CORS-free) transcription
    private var keepAlive: AVAudioPlayer?   // looping silent audio → keeps the app alive with the screen off
    private var hasSpeech = false
    private var speechFrames = 0
    private var silenceFrames = 0
    private var totalFrames = 0

    // Tuning (frames are ~100ms each via the meter timer).
    private let speechThreshold: Float = -38.0   // dBFS above which we treat sound as speech
    private let silenceHang = 6                   // ~0.6s of silence ends a phrase
    private let minSpeechFrames = 2               // need ~0.2s of speech to count as real
    private let maxFrames = 120                   // ~12s hard cap per phrase
    private let idleFrames = 50                   // ~5s of no speech → give up, return empty

    // Configure + activate the audio session (record + playback, forced to speaker)
    // and ask for mic permission. Call once when the coach session starts.
    @objc func configure(_ call: CAPPluginCall) {
        if let k = call.getString("openaiKey"), !k.isEmpty { openaiKey = k }
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
            self.stopKeepAlive()
            UIApplication.shared.isIdleTimerDisabled = false   // restore normal auto-lock
            call.resolve()
        }
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
        let external: Set<AVAudioSession.Port> = [
            .headphones, .headsetMic, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio, .usbAudio
        ]
        let hasExternal = session.currentRoute.outputs.contains { external.contains($0.portType) }
        do { try session.overrideOutputAudioPort(hasExternal ? .none : .speaker) }
        catch { print("[VoiceCapture] route error: \(error)") }
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

    // Transcribe the recorded clip with OpenAI via native URLSession (no WebView /
    // no CORS), then emit the resulting TEXT to JS.
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
