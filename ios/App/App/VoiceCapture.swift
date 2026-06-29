import Foundation
import Capacitor
import AVFoundation

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
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { granted in
            DispatchQueue.main.async {
                if !granted { call.reject("microphone permission denied"); return }
                do {
                    try session.setCategory(.playAndRecord, mode: .voiceChat,
                                            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
                    try session.setActive(true)
                    try session.overrideOutputAudioPort(.speaker)
                    call.resolve()
                } catch {
                    call.reject("audio session error: \(error.localizedDescription)")
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
            call.resolve()
        }
    }

    private func beginRecording() {
        endRecording(emit: false)   // ensure clean state
        // Re-assert speaker each turn (WebKit/interruptions can change the route).
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        try? session.overrideOutputAudioPort(.speaker)

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

        if emit && didSpeak, let url = url, let data = try? Data(contentsOf: url), data.count > 1200 {
            notifyListeners("utterance", data: [
                "audio": data.base64EncodedString(),
                "mime": "audio/m4a"
            ])
        } else if emit {
            notifyListeners("empty", data: [:])
        }
        if let url = url { try? FileManager.default.removeItem(at: url) }
    }
}
