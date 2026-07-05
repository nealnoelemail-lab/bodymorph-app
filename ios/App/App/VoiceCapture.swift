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
        CAPPluginMethod(name: "nativeLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "askAndSpeak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speakEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "printDoc", returnType: CAPPluginReturnPromise),
    ]

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var fileURL: URL?
    private var capturing = false
    private var openaiKey = ""   // passed from JS; used for native (CORS-free) transcription
    private var cartesiaKey = "" // passed from JS; used when provider == "cartesia"
    private var xaiKey = ""       // passed from JS; DIRECT-mode fallback only
    private var provider = "legacy"   // "legacy" (OpenAI Whisper) | "cartesia" (Ink-Whisper) | "grok" (Grok STT)
    // Proxy mode (keeps the real Grok key OFF the device): STT goes to our server with
    // the user's Supabase token; streaming TTS uses a short-lived xAI ephemeral token.
    private var apiBase = ""      // e.g. https://bodymorph-app.vercel.app (empty = direct mode)
    private var authToken = ""    // the user's Supabase access token (for the STT proxy)
    private var ttsToken = ""     // short-lived xAI ephemeral token (for the TTS WebSocket)
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
    private var ttsStartTime: CFAbsoluteTime = 0   // DIAG: TTS start → first audio out
    private var ttsFirstAudio = false
    private var hasSpeech = false
    private var speechFrames = 0
    private var silenceFrames = 0
    private var totalFrames = 0
    // Continuous-listen mode (workout/stretch): the mic stays ON through silence instead
    // of stopping/re-listening every idle window — no flicker. Set per listen() call.
    private var continuousListen = false

    // Tuning (frames are ~100ms each via the meter timer).
    // dBFS above which we treat sound as speech. Sits in the GAP between the ambient
    // noise floor and real speech: on-device logs showed background noise peaking near
    // -37 dBFS while actual speech runs -10 to -18 dBFS. At the old -38 the noise floor
    // touched the line, so stray noise kept registering as "speech" and resetting the
    // silence counter → end-of-phrase never fired → mic stayed open, coach never heard.
    // ADAPTIVE speech gate. Fixed thresholds kept breaking because iOS serves DIFFERENT
    // level scales depending on whether .voiceChat's processing engages (processed:
    // floor < -46, speech -43…-27; unprocessed: floor ~-45, speech -27…-9) — and it
    // engages inconsistently session to session. Instead: measure the room's own noise
    // floor continuously (EMA over non-speech frames, snap down on quieter readings)
    // and put the gate a fixed 8 dB above it, clamped to sane bounds. Self-calibrates
    // per turn, per room, per scale. History of the hand-tuned era: -38 → -30 → -33 → -42.
    private var noiseFloor: Float = -55.0
    private func speechGate() -> Float {
        return Swift.min(Swift.max(noiseFloor + 8.0, -48.0), -20.0)
    }
    private let silenceHang = 11                  // ~1.1s of silence ends a phrase — still clears a breath/pause, but snappier than 1.4s
    private let minSpeechFrames = 2               // need ~0.2s of speech to count as real
    private let maxFrames = 170                   // ~17s hard cap per phrase (room for a longer thought)
    private let idleFrames = 50                   // ~5s of no speech → give up, return empty

    // Configure + activate the audio session (record + playback, forced to speaker)
    // and ask for mic permission. Call once when the coach session starts.
    @objc func configure(_ call: CAPPluginCall) {
        if let k = call.getString("openaiKey"), !k.isEmpty { openaiKey = k }
        if let k = call.getString("cartesiaKey"), !k.isEmpty { cartesiaKey = k }
        if let k = call.getString("xaiKey"), !k.isEmpty { xaiKey = k }
        if let p = call.getString("provider"), !p.isEmpty { provider = p.lowercased() }
        // Proxy-mode credentials (empty when running in direct mode).
        if let b = call.getString("apiBase") { apiBase = b.hasSuffix("/") ? String(b.dropLast()) : b }
        if let a = call.getString("authToken"), !a.isEmpty { authToken = a }
        if let t = call.getString("ttsToken"), !t.isEmpty { ttsToken = t }
        let session = AVAudioSession.sharedInstance()
        // Set up the session BEST-EFFORT: recording works even if a routing call
        // throws, so we only fail when the mic permission is actually denied.
        func setupSessionAndResolve() {
            do {
                // .duckOthers lowers the user's music/podcast (like a GPS voice) instead
                // of stopping it while the coach talks and listens.
                // Mode stays .default ON PURPOSE. The .voiceChat experiment (2026-07-04)
                // bought noise suppression but played output on the quiet CALL-volume curve
                // ("can't hear the coach") and engaged inconsistently between sessions —
                // reverted after a night of device testing. Noisy rooms are handled by the
                // ADAPTIVE speech gate instead (learns the room's floor each turn).
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers])
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
    // ── Debug logging bridge → Xcode console (real, copy-pasteable timestamps) ──
    private let bootTime = CFAbsoluteTimeGetCurrent()
    private func ts() -> String { String(format: "+%6.2fs", CFAbsoluteTimeGetCurrent() - bootTime) }
    private func blog(_ m: String) { print("[BM \(ts())] \(m)") }
    @objc func nativeLog(_ call: CAPPluginCall) {
        blog("JS  " + (call.getString("msg") ?? ""))
        call.resolve()
    }

    @objc func listen(_ call: CAPPluginCall) {
        let continuous = call.getBool("continuous") ?? false
        DispatchQueue.main.async {
            self.continuousListen = continuous
            self.blog("listen() called  (ttsActive=\(self.ttsActive), recording=\(self.capturing), continuous=\(continuous))")
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
            // Release the audio session so the user's music/podcast UN-ducks and resumes
            // from where it left off. Without this, their music stayed silent forever.
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve()
        }
    }

    // MARK: - Streaming TTS (Grok WebSocket → progressive AVAudioEngine playback)

    @objc func speak(_ call: CAPPluginCall) {
        let text = (call.getString("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let voice = call.getString("voiceId") ?? "eve"
        let speed = max(0.7, min(1.5, call.getDouble("speed") ?? 1.0))   // Grok allows 0.7–1.5
        // Fresh short-lived credentials each utterance (proxy mode): the ephemeral TTS
        // token expires in minutes, so JS passes a current one on every speak. ALWAYS
        // reflect the caller's ttsToken — an EMPTY string is meaningful: it's the retry
        // saying "use the key (Grok voice)", so it must clear any stored token.
        if let t = call.getString("ttsToken") { ttsToken = t }
        if let a = call.getString("authToken"), !a.isEmpty { authToken = a }
        guard !ttsToken.isEmpty || !xaiKey.isEmpty else { notifyListeners("speakDone", data: ["error": "no key"]); call.resolve(); return }
        guard !text.isEmpty else { notifyListeners("speakDone", data: [:]); call.resolve(); return }
        DispatchQueue.main.async {
            self.endRecording(emit: false)   // mic OFF while the coach talks (it must never hear itself)
            self.startTTS(text: text, voice: voice, speed: speed)
            call.resolve()
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.stopTTSInternal() }
        call.resolve()
    }

    // Streaming variant: open the socket NOW (speakStream), feed text as Claude generates
    // it (speakChunk), then close it (speakEnd). Grok's TTS socket synthesizes as text
    // arrives, so the coach starts talking before the full reply exists — the latency win.
    @objc func speakStream(_ call: CAPPluginCall) {
        let voice = call.getString("voiceId") ?? "eve"
        let speed = max(0.7, min(1.5, call.getDouble("speed") ?? 1.0))
        if let t = call.getString("ttsToken") { ttsToken = t }
        if let a = call.getString("authToken"), !a.isEmpty { authToken = a }
        guard !ttsToken.isEmpty || !xaiKey.isEmpty else { notifyListeners("speakDone", data: ["error": "no key"]); call.resolve(); return }
        DispatchQueue.main.async { self.startTTSStream(voice: voice, speed: speed); call.resolve() }
    }

    @objc func speakChunk(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async { self.sendTTSDelta(text); call.resolve() }
    }

    @objc func speakEnd(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.endTTSStream(); call.resolve() }
    }

    // Full native brain→voice pipeline. The native side makes the Claude call itself
    // (URLSession CAN stream a response body, unlike WKWebView's fetch), parses the SSE
    // token stream, and feeds each token straight into the Grok voice socket — so the
    // coach starts talking within the first words instead of after the whole reply.
    // The finished reply text goes back to JS via "coachReply" (for logging); "coachError"
    // signals a failure so JS can fall back to the one-shot path.
    private var claudeTask: Task<Void, Never>?
    @objc func askAndSpeak(_ call: CAPPluginCall) {
        let endpoint = call.getString("endpoint") ?? ""
        let authTok = call.getString("authToken") ?? ""
        let body = call.getString("body") ?? "{}"
        let voice = call.getString("voiceId") ?? "eve"
        let speed = max(0.7, min(1.5, call.getDouble("speed") ?? 1.0))
        if let t = call.getString("ttsToken") { ttsToken = t }
        if let a = call.getString("authToken"), !a.isEmpty { authToken = a }
        guard !endpoint.isEmpty, let url = URL(string: endpoint) else {
            notifyListeners("coachError", data: ["error": "bad endpoint"]); call.resolve(); return
        }
        guard !ttsToken.isEmpty || !xaiKey.isEmpty else {
            notifyListeners("coachError", data: ["error": "no tts key"]); call.resolve(); return
        }
        call.resolve()   // results arrive via events, not the promise
        DispatchQueue.main.async {
            self.endRecording(emit: false)   // mic OFF while the coach thinks/talks (a timer-initiated turn can arrive mid-listen)
            self.stopTTSInternal()   // clean any prior TTS + cancel any prior claudeTask
            self.claudeTask = Task { await self.streamClaude(url: url, authToken: authTok, body: body, voice: voice, speed: speed) }
        }
    }

    // Open the Grok voice socket for a brain-stream. Does NOT call stopTTSInternal (that
    // would cancel the claudeTask driving this stream — askAndSpeak already cleaned up).
    // Called LAZILY on the first token so the socket never sits idle waiting for Claude
    // (an idle socket gets closed by the server → "bad response from the server").
    private func openStreamTTS(voice: String, speed: Double) {
        try? AVAudioSession.sharedInstance().setActive(true)
        applyOutputRoute()
        setupTTSEngine()
        ttsScheduled = 0; ttsCompleted = 0; ttsStreamDone = false; ttsActive = true
        ttsStartTime = CFAbsoluteTimeGetCurrent(); ttsFirstAudio = false
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
        let s = URLSession(configuration: .default)
        ttsURLSession = s
        let ws: URLSessionWebSocketTask
        if !ttsToken.isEmpty {
            ws = s.webSocketTask(with: url, protocols: ["xai-client-secret.\(ttsToken)"])
        } else {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(xaiKey)", forHTTPHeaderField: "Authorization")
            ws = s.webSocketTask(with: req)
        }
        ttsWS = ws; ws.resume(); receiveTTS()
    }

    // Strip emoji before speaking — mirrors the JS stripEmoji() used on the other TTS
    // paths. Filters specific emoji/symbol Unicode blocks + variation selectors/ZWJ/
    // keycap so a TTS voice never garbles or reads out a 👍/🤝/etc.; plain digits,
    // letters, and punctuation are untouched since they sit outside these ranges.
    private func stripEmoji(_ s: String) -> String {
        let ranges: [ClosedRange<UInt32>] = [
            0x1F000...0x1FFFF, 0x2600...0x27BF, 0x2B00...0x2BFF, 0x2300...0x23FF, 0x2190...0x21FF,
            0xFE00...0xFE0F, 0x200D...0x200D, 0x20E3...0x20E3, 0x3030...0x3030, 0x303D...0x303D, 0x3297...0x3297, 0x3299...0x3299,
        ]
        let filtered = s.unicodeScalars.filter { sc in !ranges.contains { $0.contains(sc.value) } }
        var out = String(String.UnicodeScalarView(filtered))
        while out.contains("  ") { out = out.replacingOccurrences(of: "  ", with: " ") }
        return out
    }

    // How many leading Characters two strings share. Used to diff what's already been
    // spoken (`sent`) against the latest cleaned text so we always send the true remaining
    // tail — even when a transform (emoji removal + space-collapse in stripEmoji) retro-
    // actively shifts earlier text. Relying on hasPrefix here would DROP the tail on any
    // such shift → cut-off sentence endings.
    private func commonPrefixCount(_ a: String, _ b: String) -> Int {
        let ca = Array(a), cb = Array(b)
        var i = 0
        while i < ca.count, i < cb.count, ca[i] == cb[i] { i += 1 }
        return i
    }

    // Speakable prefix of the reply so far — everything BEFORE the hidden ||| action tags
    // (which must never be voiced). While mid-stream, also hold back a trailing partial "|".
    private func cleanForTTS(_ full: String, final: Bool) -> String {
        let region: String
        if let r = full.range(of: "|||") { region = String(full[full.startIndex..<r.lowerBound]) }
        else if final { region = full }
        else {
            var s = full
            while s.hasSuffix("|") { s = String(s.dropLast()) }
            region = s
        }
        return stripEmoji(region)
    }

    private func streamClaude(url: URL, authToken: String, body: String, voice: String, speed: Double) async {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !authToken.isEmpty { req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body.data(using: .utf8)
        req.timeoutInterval = 30
        let session = URLSession(configuration: .default)   // dedicated — don't share with the STT session
        let reqT0 = CFAbsoluteTimeGetCurrent()
        blog("Claude request sent")
        var full = "", sent = "", opened = false
        do {
            let (bytes, resp) = try await session.bytes(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status != 200 { notifyListeners("coachError", data: ["error": "http \(status)"]); return }
            for try await line in bytes.lines {
                if Task.isCancelled { return }
                guard line.hasPrefix("data:") else { continue }
                let js = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                if js.isEmpty || js == "[DONE]" { continue }
                guard let d = js.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
                if (obj["type"] as? String) == "content_block_delta",
                   let delta = obj["delta"] as? [String: Any],
                   let text = delta["text"] as? String, !text.isEmpty {
                    full += text
                    let clean = self.cleanForTTS(full, final: false)
                    // Send the true remaining tail from the point where `clean` diverges
                    // from what we've already spoken — never skip (which would cut the end).
                    let common = self.commonPrefixCount(sent, clean)
                    if clean.count > common {
                        let piece = String(Array(clean).suffix(clean.count - common))
                        sent = clean
                        if !opened { opened = true; self.blog("Claude first token (+\(Int((CFAbsoluteTimeGetCurrent()-reqT0)*1000))ms)"); DispatchQueue.main.async { self.openStreamTTS(voice: voice, speed: speed) } }
                        DispatchQueue.main.async { self.sendTTSDelta(piece) }
                    }
                }
            }
            if Task.isCancelled { return }
            let fin = self.cleanForTTS(full, final: true)
            // Final flush — always emit the remaining tail (from the divergence point),
            // so the last words are spoken even if a late transform shifted the text.
            let finCommon = self.commonPrefixCount(sent, fin)
            if fin.count > finCommon {
                let piece = String(Array(fin).suffix(fin.count - finCommon))
                DispatchQueue.main.async { self.sendTTSDelta(piece) }
            }
            notifyListeners("coachReply", data: ["text": full])
            if opened { DispatchQueue.main.async { self.endTTSStream() } }
            else { notifyListeners("speakDone", data: [:]) }   // nothing speakable → let JS resume
        } catch {
            if Task.isCancelled { return }
            if opened {   // already speaking — finish the partial audio + log it; no fallback
                notifyListeners("coachReply", data: ["text": full])
                DispatchQueue.main.async { self.endTTSStream() }
            } else {
                notifyListeners("coachError", data: ["error": error.localizedDescription])
            }
        }
    }

    // Render an HTML document to a real PDF and present iOS's share sheet so the user
    // can Save to Files, Print (AirPrint), Mail, or AirDrop it. WKWebView's window.open
    // and window.print() don't surface any UI inside a Capacitor app, so we do it natively.
    @objc func printDoc(_ call: CAPPluginCall) {
        let html = call.getString("html") ?? ""
        let fileName = (call.getString("fileName") ?? "BodyMorph")
            .replacingOccurrences(of: "/", with: "-")
        DispatchQueue.main.async {
            // US-Letter page at 72 dpi with 1/3" margins.
            let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792)
            let printable = pageRect.insetBy(dx: 24, dy: 24)
            let formatter = UIMarkupTextPrintFormatter(markupText: html)
            let renderer = UIPrintPageRenderer()
            renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
            renderer.setValue(NSValue(cgRect: pageRect), forKey: "paperRect")
            renderer.setValue(NSValue(cgRect: printable), forKey: "printableRect")

            let pdf = NSMutableData()
            UIGraphicsBeginPDFContextToData(pdf, pageRect, nil)
            let pages = max(renderer.numberOfPages, 1)
            for i in 0..<pages {
                UIGraphicsBeginPDFPage()
                renderer.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
            }
            UIGraphicsEndPDFContext()

            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(fileName).pdf")
            do { try pdf.write(to: url, options: .atomic) }
            catch { call.reject("Couldn't build the PDF: \(error.localizedDescription)"); return }

            guard let presenter = self.bridge?.viewController else { call.reject("No view controller"); return }
            let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = share.popoverPresentationController {   // iPad anchor
                pop.sourceView = presenter.view
                pop.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
                pop.permittedArrowDirections = []
            }
            presenter.present(share, animated: true) { call.resolve() }
        }
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

    // Shared: reset state + open the Grok TTS WebSocket. Auth: PROXY mode hands the
    // short-lived ephemeral token via xAI's WebSocket form (Sec-WebSocket-Protocol:
    // xai-client-secret.<token>); DIRECT mode uses the raw key. Returns the socket, or
    // nil on a bad URL. Callers then either send the whole text at once (startTTS) or
    // stream text deltas in as Claude generates them (startTTSStream).
    private func prepAndOpenTTS(voice: String, speed: Double) -> URLSessionWebSocketTask? {
        stopTTSInternal()
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        applyOutputRoute()                       // keep playback on speaker / earbuds
        setupTTSEngine()
        ttsScheduled = 0; ttsCompleted = 0; ttsStreamDone = false; ttsActive = true
        ttsStartTime = CFAbsoluteTimeGetCurrent(); ttsFirstAudio = false   // DIAG

        var comps = URLComponents(string: "wss://api.x.ai/v1/tts")!
        comps.queryItems = [
            URLQueryItem(name: "language", value: "en"),
            URLQueryItem(name: "voice", value: voice),
            URLQueryItem(name: "codec", value: "pcm"),
            URLQueryItem(name: "sample_rate", value: "24000"),
            URLQueryItem(name: "optimize_streaming_latency", value: "2"),
            URLQueryItem(name: "speed", value: String(format: "%.2f", speed)),
        ]
        guard let url = comps.url else { return nil }
        let s = URLSession(configuration: .default)
        ttsURLSession = s
        let ws: URLSessionWebSocketTask
        if !ttsToken.isEmpty {
            ws = s.webSocketTask(with: url, protocols: ["xai-client-secret.\(ttsToken)"])
        } else {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(xaiKey)", forHTTPHeaderField: "Authorization")
            ws = s.webSocketTask(with: req)
        }
        ttsWS = ws
        ws.resume()
        return ws
    }

    // One-shot: send the whole reply at once. (Fallback path + non-streaming callers.)
    private func startTTS(text: String, voice: String, speed: Double) {
        blog("TTS start (one-shot, \(text.count) chars)")
        guard let ws = prepAndOpenTTS(voice: voice, speed: speed) else { finishTTS(error: "bad url"); return }
        if let msg = try? JSONSerialization.data(withJSONObject: ["type": "text.delta", "delta": text]),
           let str = String(data: msg, encoding: .utf8) {
            ws.send(.string(str)) { _ in }
        }
        ws.send(.string("{\"type\":\"text.done\"}")) { _ in }
        receiveTTS()
    }

    // Streaming: open the socket now; text arrives via sendTTSDelta() and completes via
    // endTTSStream(). Audio plays as it's synthesized so the coach starts talking early.
    private func startTTSStream(voice: String, speed: Double) {
        guard prepAndOpenTTS(voice: voice, speed: speed) != nil else { finishTTS(error: "bad url"); return }
        receiveTTS()
    }

    private func sendTTSDelta(_ text: String) {
        guard let ws = ttsWS, ttsActive, !text.isEmpty else { return }
        if let msg = try? JSONSerialization.data(withJSONObject: ["type": "text.delta", "delta": text]),
           let str = String(data: msg, encoding: .utf8) {
            ws.send(.string(str)) { _ in }
        }
    }

    private func endTTSStream() {
        guard let ws = ttsWS, ttsActive else { return }
        ws.send(.string("{\"type\":\"text.done\"}")) { _ in }
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
            if !self.ttsEngine.isRunning {
                try? self.ttsEngine.start()
                // .voiceChat's processing unit resets the output to the quiet RECEIVER when
                // the engine spins up — re-assert speaker/earbuds AFTER the engine is live.
                self.applyOutputRoute()
            }
            if !self.ttsPlayer.isPlaying { self.ttsPlayer.play() }
            if !self.ttsFirstAudio {   // DIAG: first audio scheduled → report TTS latency once
                self.ttsFirstAudio = true
                let ms = Int((CFAbsoluteTimeGetCurrent() - self.ttsStartTime) * 1000)
                self.blog("TTS first audio out (+\(ms)ms from socket open)")
                self.notifyListeners("speakStart", data: ["ttsMs": ms])
            }
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
        blog("TTS done (err=\(error ?? "none"))")
        let hadError = error != nil
        stopTTSInternal()
        notifyListeners("speakDone", data: hadError ? ["error": error!] : [:])
    }

    private func stopTTSInternal() {
        ttsActive = false
        claudeTask?.cancel(); claudeTask = nil   // stop any in-flight native Claude stream
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
    private var routeObserved = false
    private func observeRouteChanges() {
        if routeObserved { return }
        routeObserved = true
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self else { return }
            // ONLY react to real device plug/unplug. Our own overrideOutputAudioPort calls
            // fire this same notification (reason .override) — reacting to those looped the
            // handler into a receiver↔speaker ping-pong that knocked out the voice-processing
            // unit mid-session (Neal's quiet-start-then-suddenly-loud log).
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason == .newDeviceAvailable || reason == .oldDeviceUnavailable else { return }
            self.applyOutputRoute()
            // AVAudioEngine can stall across a route swap mid-playback (the 26s freeze
            // when AirPods were inserted) — kick it back to life on the new route.
            if self.ttsActive {
                if !self.ttsEngine.isRunning { try? self.ttsEngine.start() }
                if !self.ttsPlayer.isPlaying { self.ttsPlayer.play() }
            }
        }
    }

    private func applyOutputRoute() {
        observeRouteChanges()
        let session = AVAudioSession.sharedInstance()
        let external: Set<AVAudioSession.Port> = [
            .headphones, .headsetMic, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .carAudio, .usbAudio
        ]
        let outputs = session.currentRoute.outputs.map { $0.portType }
        let hasExternal = outputs.contains { external.contains($0) }
        let onSpeaker = outputs.contains(.builtInSpeaker)
        // IDEMPOTENT: only touch the override when the route is actually wrong. Blind
        // .none→.speaker cycles generate route-change churn (and with voiceChat's processing
        // unit, each churn risks a reset that flips volume/level scales mid-session).
        if hasExternal {
            try? session.overrideOutputAudioPort(.none)      // let earbuds/headset carry it
        } else if !onSpeaker {
            try? session.overrideOutputAudioPort(.speaker)   // bare phone → loudspeaker, never the receiver
        }
    }

    // Start a fresh recorder + reset the VAD counters. Returns false if it couldn't start.
    private func startRecorder() -> Bool {
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
        guard let r = try? AVAudioRecorder(url: url, settings: settings) else { return false }
        r.isMeteringEnabled = true
        r.delegate = self
        r.record()
        recorder = r
        capturing = true
        return true
    }

    private func beginRecording() {
        endRecording(emit: false)   // ensure clean state
        // Re-assert the route each turn (WebKit/interruptions can change it).
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        applyOutputRoute()

        if startRecorder() {
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                self?.tick()
            }
        } else {
            notifyListeners("empty", data: [:])
        }
    }

    // Continuous-listen mode only: silently roll to a FRESH recording segment WITHOUT
    // tearing down the meter timer or notifying JS — the mic stays "on" from the user's
    // point of view (level events keep flowing, no re-listen round-trip), while the
    // underlying file rolls so we never accumulate or send a long stretch of silence.
    private func rollRecording() {
        let old = recorder; recorder = nil
        old?.stop()
        if let u = fileURL { try? FileManager.default.removeItem(at: u) }
        if !startRecorder() { notifyListeners("empty", data: [:]) }
    }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        let power = r.averagePower(forChannel: 0)   // ~ -160 (silent) … 0 (loud)
        // Surface a 0–100 level for the on-screen meter.
        let level = max(0.0, min(100.0, (power + 60.0) / 60.0 * 100.0))
        notifyListeners("level", data: ["level": level])

        totalFrames += 1
        // CALIBRATION WINDOW: the first 0.4s after the mic opens teaches the floor
        // unconditionally (the user hasn't started answering yet). Without this, a loud
        // room deadlocks: ambient > stale gate → everything counts as "speech" → the
        // floor (only taught by non-speech frames) never learns the room.
        if totalFrames <= 4 {
            if power < noiseFloor { noiseFloor = power }
            else { noiseFloor = 0.6 * noiseFloor + 0.4 * power }
            return
        }
        if power > speechGate() {
            hasSpeech = true; speechFrames += 1; silenceFrames = 0
        } else {
            // Non-speech frame → teach the noise floor. Snap DOWN instantly on quieter
            // readings; drift UP slowly (EMA) so a loudening room raises the gate without
            // one cough poisoning it. Speech frames never touch the floor.
            if power < noiseFloor { noiseFloor = power }
            else { noiseFloor = 0.95 * noiseFloor + 0.05 * power }
            if hasSpeech { silenceFrames += 1 }
        }

        if hasSpeech && silenceFrames >= silenceHang && speechFrames >= minSpeechFrames {
            endRecording(emit: true)            // natural end of phrase
        } else if totalFrames >= maxFrames {
            endRecording(emit: hasSpeech)       // hard cap
        } else if !hasSpeech && totalFrames >= idleFrames {
            // Nobody spoke this window. Continuous mode (workout/stretch): keep the mic ON
            // and silently roll the file. Companion mode: stop → JS re-listens (idle-nudge
            // logic lives up in JS and needs the empty signal).
            if continuousListen { rollRecording() }
            else { endRecording(emit: false) }
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
        let sttT0 = CFAbsoluteTimeGetCurrent()   // DIAG: measure STT network round-trip
        let useProxy = !apiBase.isEmpty && !authToken.isEmpty
        let useGrok = (provider == "grok") && !xaiKey.isEmpty
        let useCartesia = (provider == "cartesia") && !cartesiaKey.isEmpty
        // Proxy mode: send to OUR server with the Supabase token — the server holds the
        // real Grok key. Otherwise call the vendor directly (direct-mode fallback).
        let endpoint: String, bearer: String, inferModel: Bool
        if useProxy {
            endpoint = apiBase + "/api/grok-stt"; bearer = authToken; inferModel = true   // server forwards to Grok
        } else if useGrok {
            endpoint = "https://api.x.ai/v1/stt"; bearer = xaiKey; inferModel = true
        } else if useCartesia {
            endpoint = "https://api.cartesia.ai/stt"; bearer = cartesiaKey; inferModel = false
        } else {
            endpoint = "https://api.openai.com/v1/audio/transcriptions"; bearer = openaiKey; inferModel = false
        }
        guard !bearer.isEmpty else {
            try? FileManager.default.removeItem(at: url)
            notifyListeners("empty", data: ["error": "no key"]); return
        }
        var req = URLRequest(url: URL(string: endpoint)!)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if useCartesia { req.setValue("2026-03-01", forHTTPHeaderField: "Cartesia-Version") }
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        if !inferModel {   // Grok (direct or via proxy) infers the model; OpenAI + Cartesia need it
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
        blog("STT POST → (\(body.count) bytes)")
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err {
                self.blog("STT net err: \(err.localizedDescription)")
                self.notifyListeners("empty", data: ["error": "net: \(err.localizedDescription)"]); return
            }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = json["text"] as? String {
                let sttMs = Int((CFAbsoluteTimeGetCurrent() - sttT0) * 1000)   // DIAG
                self.blog("STT done \(sttMs)ms: \"\(text)\"")
                self.notifyListeners("utterance", data: ["text": text, "sttMs": sttMs])
            } else {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.blog("STT http \(status)")
                self.notifyListeners("empty", data: ["error": "http \(status): \(String(bodyStr.prefix(140)))"])
            }
        }.resume()
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// HealthKit plugin — reads STEPS + SLEEP from Apple Health (which aggregates the
// iPhone's motion chip, Apple Watch, and any app that writes to Health). Read-only.
// Lives in this file so it's already in the app target's Compile Sources (no separate
// project-file surgery). Registered on the bridge in AppDelegate next to VoiceCapture.
// ══════════════════════════════════════════════════════════════════════════════
import HealthKit

@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthKitPlugin"
    public let jsName = "HealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTodaySteps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLastNightSleep", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    private func readTypes() -> Set<HKObjectType> {
        var s = Set<HKObjectType>()
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) { s.insert(steps) }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { s.insert(sleep) }
        return s
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["granted": false]); return }
        store.requestAuthorization(toShare: nil, read: readTypes()) { ok, err in
            // Apple deliberately never tells us WHICH read types the user allowed (privacy).
            // `ok` just means the sheet completed without error — we treat that as "proceed
            // and try to read"; a denied type simply returns zero samples.
            call.resolve(["granted": ok, "error": err?.localizedDescription ?? ""])
        }
    }

    // Total steps since local midnight today.
    @objc func getTodaySteps(_ call: CAPPluginCall) {
        guard let stepType = HKObjectType.quantityType(forIdentifier: .stepCount) else { call.resolve(["steps": 0]); return }
        let start = Calendar.current.startOfDay(for: Date())
        let pred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let q = HKStatisticsQuery(quantityType: stepType, quantitySamplePredicate: pred, options: .cumulativeSum) { _, stats, _ in
            let steps = stats?.sumQuantity()?.doubleValue(for: HKUnit.count()) ?? 0
            call.resolve(["steps": Int(steps.rounded())])
        }
        store.execute(q)
    }

    // Hours ASLEEP for "last night" — samples overlapping the window from 6pm yesterday
    // to 11am today, summing only the actually-asleep categories (not just "in bed").
    @objc func getLastNightSleep(_ call: CAPPluginCall) {
        guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { call.resolve(["hours": 0]); return }
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        let windowStart = cal.date(byAdding: .hour, value: -6, to: todayStart)!   // 6pm yesterday
        let windowEnd = cal.date(byAdding: .hour, value: 11, to: todayStart)!     // 11am today
        let pred = HKQuery.predicateForSamples(withStart: windowStart, end: windowEnd, options: [])
        let q = HKSampleQuery(sampleType: sleepType, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
            var seconds = 0.0
            for s in (samples as? [HKCategorySample]) ?? [] {
                if self.isAsleep(s.value) { seconds += s.endDate.timeIntervalSince(s.startDate) }
            }
            call.resolve(["hours": (seconds / 3600.0 * 10).rounded() / 10])   // one decimal
        }
        store.execute(q)
    }

    // "Asleep" across iOS versions: iOS 16+ splits core/deep/REM; older is a single
    // .asleep value. Accept any asleep stage; exclude .inBed and .awake.
    private func isAsleep(_ value: Int) -> Bool {
        if #available(iOS 16.0, *) {
            switch value {
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                 HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                 HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                 HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                return true
            default: return false
            }
        } else {
            return value == HKCategoryValueSleepAnalysis.asleep.rawValue
        }
    }
}
