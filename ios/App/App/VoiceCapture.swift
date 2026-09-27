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
            // Non-speech frame → teach the noise floor. Fall FASTER than we rise, but never
            // instantly: TV/gym noise fluctuates, and snapping to the quietest split-second
            // (a pause between TV words) dropped the gate under the babble — then chatter
            // read as endless "speech" and phrase-end never fired (Neal's TV log: 3 turns
            // swallowed into "you good?" nudges). 20%/frame ≈ settles in ~1s, immune to blips.
            if power < noiseFloor { noiseFloor = 0.8 * noiseFloor + 0.2 * power }
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
// OpenAI Realtime — SPEECH-TO-SPEECH coach (experimental, behind VOICE_PROVIDER)
//
// The existing coach is three hops: native mic → Grok STT → Claude → Grok TTS. This
// is one hop: the model hears the audio and answers in audio. Parked alongside the
// old stack, not replacing it — VITE_VOICE_PROVIDER picks which one runs.
//
// It lives in native code for the same reason streaming TTS does: the WebView can't
// set the Authorization header this socket needs, and on a real device the WebView
// mic is dead. So Swift owns the socket AND both directions of audio; JS only sends
// the session config and receives events (transcripts, tool calls, state).
//
// Audio contract with OpenAI: 24 kHz mono PCM16, base64, both ways.
// ══════════════════════════════════════════════════════════════════════════════
@objc(RealtimeVoicePlugin)
public class RealtimeVoicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RealtimeVoicePlugin"
    public let jsName = "RealtimeVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendToolResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRunning", returnType: CAPPluginReturnPromise),
    ]

    private var ws: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var running = false

    // Playback: one engine, one player node, 24 kHz float32 (what AVAudioEngine wants).
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playFormat: AVAudioFormat?
    private var engineReady = false

    // Capture: a tap on the input node, converted to 24 kHz PCM16 for the socket.
    private var converter: AVAudioConverter?
    private var capturing = false
    private var micFormat: AVAudioFormat?

    // ── Mic gate while the coach is talking ────────────────────────────────────
    // Apple's echo cancellation needs a moment to converge, and until it does the
    // coach's own voice reaches the mic. The server hears it, counts it as the user
    // taking a turn, and the coach interrupts itself — which is the "jerky startup".
    // So we simply stop SENDING while audio is playing, plus a short tail for the
    // speaker to finish and the room to settle.
    // Trade-off, deliberately taken: no barge-in. Talking over the coach won't stop
    // it. Set GATE_MIC_WHILE_SPEAKING = false to get interruption back at the cost of
    // the self-triggering above.
    private let GATE_MIC_WHILE_SPEAKING = true
    private let micGateTailMs: Double = 600
    private var lastAudioOutAt: CFAbsoluteTime = 0

    // ── Local speech gate: don't pay to stream silence ─────────────────────────
    // Realtime bills every 100ms of audio we SEND, at $32/1M tokens. Holding the
    // socket open costs nothing — shipping silence down it does. In a gym the coach
    // may be open for 45 minutes and spoken to for five, so streaming the other 40
    // is most of the bill for no benefit.
    //
    // Same self-calibrating approach the legacy capture already uses: track the room's
    // noise floor and put the gate a fixed margin above it, so it adapts per room
    // rather than fighting a hand-tuned constant.
    //
    // PRE-ROLL is what makes this safe. Gating on speech alone clips the first word,
    // because by the time the level crosses the threshold the word has begun. So the
    // most recent ~400ms is always kept buffered and flushed the instant speech starts
    // — the server receives the full onset and its own turn detection still works.
    private var micFloorDb: Float = -55
    private var micSpeaking = false
    private var lastVoiceAt: CFAbsoluteTime = 0

    // ── Telling the client apart from the television ───────────────────────────
    // Confirmed on device: a TV in the room was transcribed and sent as the client's
    // own speech. Level-versus-floor cannot fix that, because broadcast speech IS
    // speech — and worse, the floor never learned the TV at all. The floor only
    // updates from buffers BELOW the gate, so chatter loud enough to pass left the
    // floor sitting at its -70 clamp while the gate stayed pinned at the -48 backstop,
    // which is exactly where across-room dialogue lands.
    //
    // The discriminator that does exist is DISTANCE. The client's mouth is about a
    // foot from the phone; a television is across the room and arrives 15-25 dB
    // quieter. So track how loud this person is when they genuinely speak, and refuse
    // anything far below it.
    //
    // Deliberate trade: someone speaking very softly, or with the phone on a bench
    // several feet away, has to speak up. That is the right side to err on — a coach
    // answering the television is worse than a coach missing a murmur, and the client
    // can always move closer. `peakDb` is reported in the gate telemetry so this can
    // be retuned from a real log rather than by guesswork.
    private var micPeakDb: Float = -100        // -100 = haven't heard them talk yet
    private var lastPeakAt: CFAbsoluteTime = 0
    private let peakDecayDbPerSec: Float = 2.0 // forget a loud moment slowly
    private let realSpeechDb: Float = -35.0    // above this = genuinely close-mic
    private let talkWindowDb: Float = 16.0     // how far under their own voice we accept
    private let voiceHangSec: Double = 1.2      // MUST exceed the server's silence window
    private let preRollMax = 10                 // ~400ms of buffers
    private var preRoll: [Data] = []
    private var framesSent = 0
    private var framesSkipped = 0
    private var lastGateReport: CFAbsoluteTime = 0

    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

    // MARK: - Lifecycle

    @objc func isRunning(_ call: CAPPluginCall) { call.resolve(["running": running]) }

    @objc func start(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        let model = call.getString("model") ?? "gpt-realtime"
        let sessionJSON = call.getString("session") ?? "{}"
        guard !token.isEmpty else { call.reject("no token"); return }

        stopInternal()

        // Forget the last session's room. The plugin outlives a conversation, and a
        // voice reference learned shouting over a gym would make the gate too strict
        // at home the next morning.
        micPeakDb = -100
        lastPeakAt = 0
        micFloorDb = -55
        framesSent = 0
        framesSkipped = 0
        preRoll.removeAll()

        guard var comps = URLComponents(string: "wss://api.openai.com/v1/realtime") else { call.reject("bad url"); return }
        comps.queryItems = [URLQueryItem(name: "model", value: model)]
        guard let url = comps.url else { call.reject("bad url"); return }

        var req = URLRequest(url: url)
        // The ephemeral secret minted by /api/openai-token. The real key never ships.
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // NO "OpenAI-Beta: realtime=v1" header. That was the pre-GA handshake, and
        // sending it now gets the socket closed immediately with "The Realtime Beta API
        // is no longer supported." The GA endpoint wants the bearer token and nothing else.

        let s = URLSession(configuration: .default)
        urlSession = s
        let task = s.webSocketTask(with: req)
        ws = task
        running = true
        task.resume()

        // Session config (persona + tools) comes straight from JS so the coach is
        // defined in one place, not duplicated in Swift.
        sendRaw("{\"type\":\"session.update\",\"session\":\(sessionJSON)}")
        receiveLoop()

        // Audio MUST be set up on the main thread: Capacitor dispatches plugin calls on
        // a background queue, and configuring AVAudioSession / starting AVAudioEngine
        // off-main fails quietly — which looks exactly like "the mic never turned on".
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        self.notifyListeners("rtError", data: ["error": "microphone permission denied"])
                        return
                    }
                    self.startAudio()
                    // Speak FIRST, before anyone says anything. It matches how the shipped
                    // coach opens, and it proves the audio path works even if the mic
                    // doesn't — silence then tells us which half is broken.
                    self.sendRaw("{\"type\":\"response.create\"}")
                }
            }
        }
        notifyListeners("rtOpen", data: [:])
        call.resolve(["ok": true])
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopInternal()
        call.resolve()
    }

    private func stopInternal() {
        running = false
        stopCapture()
        stopPlayback()
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    // MARK: - Socket

    private func sendRaw(_ json: String) {
        guard let ws = ws else { return }
        ws.send(.string(json)) { err in
            if let err = err { print("[Realtime] send error: \(err.localizedDescription)") }
        }
    }

    // JS answers a tool call: forward the result and ask for the spoken reply.
    @objc func sendToolResult(_ call: CAPPluginCall) {
        let callId = call.getString("callId") ?? ""
        let output = call.getString("output") ?? "{}"
        guard !callId.isEmpty else { call.resolve(); return }
        let escaped = output.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        sendRaw("{\"type\":\"conversation.item.create\",\"item\":{\"type\":\"function_call_output\",\"call_id\":\"\(callId)\",\"output\":\"\(escaped)\"}}")
        sendRaw("{\"type\":\"response.create\"}")
        call.resolve()
    }

    private func receiveLoop() {
        guard let ws = ws else { return }
        ws.receive { [weak self] result in
            guard let self = self, self.running else { return }
            switch result {
            case .failure(let err):
                self.notifyListeners("rtError", data: ["error": err.localizedDescription])
                self.stopInternal()
            case .success(let msg):
                if case .string(let text) = msg { self.handleEvent(text) }
                if case .data(let d) = msg, let text = String(data: d, encoding: .utf8) { self.handleEvent(text) }
                self.receiveLoop()
            }
        }
    }

    private func handleEvent(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {
        case "response.output_audio.delta", "response.audio.delta":
            if let b64 = obj["delta"] as? String { playPCM16(base64: b64) }

        // BARGE-IN: the user started talking over the coach. Drop whatever is queued
        // so the coach stops mid-sentence like a person would, instead of finishing
        // its turn into a conversation that has already moved on.
        case "input_audio_buffer.speech_started":
            // ONLY cut the coach off if OUR OWN gate also heard speech.
            //
            // The server's detector judges whatever we send it, and during playback
            // that includes echo the cancellation didn't fully remove. Honouring it
            // unconditionally chopped the coach off mid-word — Neal heard it as a
            // "snapping noise, like you're shutting off abruptly", and the log shows
            // sentences ending mid-phrase plus a run of cancelled zero-token turns.
            //
            // micSpeaking is the local gate, which during playback sits 20dB above the
            // room floor — far above residual echo, but well under someone actually
            // talking into the phone. Real barge-in still works; phantom ones don't.
            if micSpeaking {
                flushPlayback()
                notifyListeners("rtUserSpeaking", data: [:])
            }

        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            notifyListeners("rtCoachSaid", data: ["text": obj["transcript"] as? String ?? ""])

        case "conversation.item.input_audio_transcription.completed":
            notifyListeners("rtUserSaid", data: ["text": obj["transcript"] as? String ?? ""])

        case "response.function_call_arguments.done":
            notifyListeners("rtToolCall", data: [
                "callId": obj["call_id"] as? String ?? "",
                "name": obj["name"] as? String ?? "",
                "arguments": obj["arguments"] as? String ?? "{}",
            ])

        case "response.done":
            // Every turn reports exactly what it consumed. Forward it verbatim rather
            // than estimating from wall-clock — this is the billing ground truth.
            var usageJSON = ""
            if let resp = obj["response"] as? [String: Any],
               let usage = resp["usage"],
               let d = try? JSONSerialization.data(withJSONObject: usage),
               let str = String(data: d, encoding: .utf8) {
                usageJSON = str
            }
            notifyListeners("rtTurnDone", data: ["usage": usageJSON])

        case "error":
            let e = (obj["error"] as? [String: Any])?["message"] as? String ?? "unknown"
            notifyListeners("rtError", data: ["error": e])

        default: break
        }
    }

    // MARK: - Playback (model voice out)

    private func setupEngine() {
        if engineReady { return }
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)
        playFormat = fmt
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: fmt)
        engineReady = true
    }

    private func playPCM16(base64: String) {
        guard let raw = Data(base64Encoded: base64), !raw.isEmpty, let fmt = playFormat else { return }
        lastAudioOutAt = CFAbsoluteTimeGetCurrent()   // the coach is talking right now
        let frames = raw.count / 2
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        raw.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) in
            let src = ptr.bindMemory(to: Int16.self)
            let dst = buf.floatChannelData![0]
            for i in 0..<frames { dst[i] = max(-1.0, min(1.0, Float(src[i]) / 32768.0)) }
        }
        if !player.isPlaying { player.play() }
        player.scheduleBuffer(buf, completionHandler: nil)
    }

    private func flushPlayback() {
        player.stop()
        player.reset()
        if engine.isRunning { player.play() }
    }

    private func stopPlayback() {
        player.stop()
        if engine.isRunning { engine.stop() }
    }

    // MARK: - Capture (user voice in)

    private func startAudio() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .voiceChat gives Apple's echo cancellation, which a speech-to-speech coach
            // NEEDS: the mic is open while the coach talks, so without it the model hears
            // itself and answers its own sentences. The old stack deliberately avoids
            // .voiceChat (it routes to the quieter call-volume curve) — but that stack is
            // half-duplex and never listens while speaking, so it doesn't need AEC.
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch { print("[Realtime] audio session: \(error)") }

        setupEngine()
        let input = engine.inputNode
        // Hardware/OS echo cancellation + noise suppression on the input.
        if #available(iOS 13.0, *) { try? input.setVoiceProcessingEnabled(true) }

        let inFmt = input.outputFormat(forBus: 0)
        micFormat = inFmt
        converter = AVAudioConverter(from: inFmt, to: outFormat)

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: inFmt) { [weak self] buffer, _ in
            self?.sendMic(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
            capturing = true
            // Report the real rates: a mismatch here is the usual cause of "it hears
            // nothing" or "it sounds like chipmunks".
            notifyListeners("rtAudio", data: ["micHz": Int(inFmt.sampleRate), "outHz": 24000])
        } catch {
            notifyListeners("rtError", data: ["error": "mic start: \(error.localizedDescription)"])
        }
    }

    private func stopCapture() {
        if capturing { engine.inputNode.removeTap(onBus: 0); capturing = false }
        converter = nil
    }

    private func sendMic(_ buffer: AVAudioPCMBuffer) {
        guard running, let converter = converter else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }

        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if error != nil || out.frameLength == 0 { return }   // converter priming — nothing to send yet

        let bytes = Int(out.frameLength) * 2
        guard bytes > 0 else { return }
        guard let ch = out.int16ChannelData else { return }
        let data = Data(bytes: ch[0], count: bytes)

        // ── Is anyone actually talking? ────────────────────────────────────────
        let level = levelDb(buffer)
        let now = CFAbsoluteTimeGetCurrent()

        // While the coach is talking, raise the bar instead of muting. Muting lost the
        // start of anything said over the coach — "Coach, I did not say that" reached
        // the server as "Not say that" — and with nothing getting through, the coach
        // talked straight over him. Ducking keeps real speech (which is loud, and close
        // to the phone) while residual echo stays under the line.
        let coachTalking = (now - lastAudioOutAt) * 1000 < micGateTailMs
        let margin: Float = coachTalking ? 26.0 : 8.0

        // Learn how loud this person is — but never from the coach's own playback, or
        // the echo would inflate the reference and deafen the gate to the client.
        if !coachTalking {
            let dt = lastPeakAt > 0 ? Float(now - lastPeakAt) : 0
            lastPeakAt = now
            if micPeakDb <= -99 { micPeakDb = level }                            // seed, don't crawl
            else if level > micPeakDb { micPeakDb = 0.4 * micPeakDb + 0.6 * level }
            else { micPeakDb -= peakDecayDbPerSec * dt }                         // slow release
            micPeakDb = Swift.min(Swift.max(micPeakDb, -100.0), -6.0)
        }

        // Once we know what they sound like, hold the line relative to THEM. Until
        // then stay at -44: strict enough to sit above typical across-room dialogue,
        // loose enough that a normal voice opens it on the first word.
        let heardRealSpeech = micPeakDb > realSpeechDb
        let floorClamp: Float = coachTalking ? -34.0 : (heardRealSpeech ? -42.0 : -44.0)
        var gate = Swift.max(micFloorDb + margin, floorClamp)
        if heardRealSpeech && !coachTalking { gate = Swift.max(gate, micPeakDb - talkWindowDb) }
        gate = Swift.min(gate, -20.0)

        if level > gate {
            lastVoiceAt = now
            if !micSpeaking {
                micSpeaking = true
                // Flush the pre-roll so the server hears the word that started this,
                // not the middle of it.
                for chunk in preRoll { sendAudio(chunk) }
                framesSent += preRoll.count
                preRoll.removeAll()
            }
        } else {
            // Only learn the floor from NON-speech, or loud talking would drag the
            // threshold up behind it and the gate would slowly go deaf.
            let next = level < micFloorDb ? (0.8 * micFloorDb + 0.2 * level)
                                          : (0.9 * micFloorDb + 0.1 * level)
            // A real room floor lives between roughly -70 and -25 dB. Anything below
            // that is digital silence, and letting the average chase it made the gate
            // deaf to its own threshold.
            micFloorDb = Swift.min(Swift.max(next, -70.0), -25.0)
            if micSpeaking && (now - lastVoiceAt) > voiceHangSec { micSpeaking = false }
        }

        if micSpeaking {
            sendAudio(data)
            framesSent += 1
        } else {
            // Always buffered, never dropped — this is what preserves the first word.
            preRoll.append(data)
            if preRoll.count > preRollMax { preRoll.removeFirst() }
            framesSkipped += 1
        }

        // Periodic proof it's working, and by how much.
        if now - lastGateReport > 15 {
            lastGateReport = now
            let total = framesSent + framesSkipped
            if total > 0 {
                notifyListeners("rtGate", data: ["sentPct": Int(Double(framesSent) / Double(total) * 100),
                                                 "floorDb": Int(micFloorDb),
                                                 "peakDb": Int(micPeakDb),
                                                 "gateDb": Int(gate)])
            }
        }
    }

    private func sendAudio(_ data: Data) {
        sendRaw("{\"type\":\"input_audio_buffer.append\",\"audio\":\"\(data.base64EncodedString())\"}")
    }

    // RMS of the mic buffer in dBFS: ~-160 silent, 0 clipping. Same scale the legacy
    // capture's averagePower reports, so the +8dB margin carries over.
    private func levelDb(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData, buffer.frameLength > 0 else { return -160 }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { let v = ch[0][i]; sum += v * v }
        let rms = sqrtf(sum / Float(n))
        return rms > 0 ? 20 * log10f(rms) : -160
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
        CAPPluginMethod(name: "getTodayEnergy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLastNightSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailyMetrics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailySleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWorkouts", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    private func readTypes() -> Set<HKObjectType> {
        var s = Set<HKObjectType>()
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) { s.insert(steps) }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { s.insert(sleep) }
        // Watch-grade metrics for the weekly progress reports (read-only, aggregates only).
        if let rhr = HKObjectType.quantityType(forIdentifier: .restingHeartRate) { s.insert(rhr) }
        if let energy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { s.insert(energy) }
        // Resting/basal burn — the OTHER half of "total calories burned". The Move ring
        // only shows active; a day's real total is active + resting (~1800-2000 kcal).
        if let basal = HKObjectType.quantityType(forIdentifier: .basalEnergyBurned) { s.insert(basal) }
        if let exmin = HKObjectType.quantityType(forIdentifier: .appleExerciseTime) { s.insert(exmin) }
        if let dist = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { s.insert(dist) }
        if let hrv = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN) { s.insert(hrv) }
        if let vo2 = HKObjectType.quantityType(forIdentifier: .vo2Max) { s.insert(vo2) }
        s.insert(HKObjectType.workoutType())
        return s
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["granted": false]); return }
        // MAIN THREAD: Capacitor dispatches plugin calls on a background queue, and this
        // call presents a system sheet. Off-main it can complete without ever showing UI —
        // which looks exactly like "I tapped it and nothing happened."
        DispatchQueue.main.async {
            self.store.requestAuthorization(toShare: nil, read: self.readTypes()) { ok, err in
                // Apple deliberately never tells us WHICH read types the user allowed (privacy).
                // `ok` just means the sheet completed without error — we treat that as "proceed
                // and try to read"; a denied type simply returns zero samples.
                call.resolve(["granted": ok, "error": err?.localizedDescription ?? ""])
            }
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

    // TODAY'S TOTAL CALORIES BURNED = active (movement) + basal (resting metabolism).
    // Apple's Move ring shows ACTIVE only, which reads absurdly low next to food intake;
    // the number people mean by "calories burned today" is the sum. Returns both parts
    // plus the total so the UI can explain itself, and -1 when a type is unavailable /
    // unauthorized so the caller can show a dash instead of a fake 0.
    @objc func getTodayEnergy(_ call: CAPPluginCall) {
        let start = Calendar.current.startOfDay(for: Date())
        let pred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let group = DispatchGroup()
        var active: Double = -1
        var basal: Double = -1

        func sum(_ id: HKQuantityTypeIdentifier, into store2: @escaping (Double) -> Void) {
            guard let t = HKObjectType.quantityType(forIdentifier: id) else { return }
            group.enter()
            let q = HKStatisticsQuery(quantityType: t, quantitySamplePredicate: pred, options: .cumulativeSum) { _, stats, _ in
                if let kcal = stats?.sumQuantity()?.doubleValue(for: .kilocalorie()) { store2(kcal) }
                group.leave()
            }
            self.store.execute(q)
        }

        sum(.activeEnergyBurned) { active = $0 }
        sum(.basalEnergyBurned) { basal = $0 }

        group.notify(queue: .main) {
            let a = active >= 0 ? active : 0
            let b = basal >= 0 ? basal : 0
            let haveAny = active >= 0 || basal >= 0
            call.resolve([
                "activeKcal": active >= 0 ? Int(a.rounded()) : -1,
                "restingKcal": basal >= 0 ? Int(b.rounded()) : -1,
                "totalKcal": haveAny ? Int((a + b).rounded()) : -1,
            ])
        }
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

    // Per-day sleep hours for the last N days → [{day, hours}], for the sleep trend chart.
    // Each asleep sample is attributed to the date it ENDS (the morning you wake up).
    @objc func getDailySleep(_ call: CAPPluginCall) {
        guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { call.resolve(["days": []]); return }
        let days = max(1, min(400, call.getInt("days") ?? 180))
        let cal = Calendar.current
        let start = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: Date()))!
        let pred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: [])
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone.current
        let q = HKSampleQuery(sampleType: sleepType, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
            var byDay: [String: Double] = [:]
            for s in (samples as? [HKCategorySample]) ?? [] {
                if self.isAsleep(s.value) {
                    let day = fmt.string(from: s.endDate)
                    byDay[day, default: 0] += s.endDate.timeIntervalSince(s.startDate)
                }
            }
            let out = byDay.keys.sorted().map { d -> [String: Any] in ["day": d, "hours": (byDay[d]! / 3600.0 * 10).rounded() / 10] }
            DispatchQueue.main.async { call.resolve(["days": out]) }
        }
        store.execute(q)
    }

    // Per-day watch metrics for the last N days (default 14): resting heart rate (bpm),
    // active energy (kcal), exercise minutes, distance (km), HRV (ms). One statistics-
    // collection query per metric, merged into [{day, restingHR, activeKcal, exerciseMin,
    // distanceKm, hrvMs}]. Days with no data carry nulls — JS skips them.
    @objc func getDailyMetrics(_ call: CAPPluginCall) {
        let days = max(1, min(400, call.getInt("days") ?? 14))   // up to ~1yr for trend charts
        let cal = Calendar.current
        let end = Date()
        let start = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: end))!
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone.current

        // (identifier, options, unit, jsonKey, scale-to-round)
        let specs: [(HKQuantityTypeIdentifier, HKStatisticsOptions, HKUnit, String, Double)] = [
            (.restingHeartRate, .discreteAverage, HKUnit.count().unitDivided(by: .minute()), "restingHR", 1),
            (.activeEnergyBurned, .cumulativeSum, .kilocalorie(), "activeKcal", 1),
            (.appleExerciseTime, .cumulativeSum, .minute(), "exerciseMin", 1),
            (.distanceWalkingRunning, .cumulativeSum, .meterUnit(with: .kilo), "distanceKm", 10),
            (.heartRateVariabilitySDNN, .discreteAverage, .secondUnit(with: .milli), "hrvMs", 1),
            (.vo2Max, .discreteAverage, HKUnit(from: "ml/kg*min"), "vo2Max", 10),
        ]

        var byDay: [String: [String: Double]] = [:]
        let lock = NSLock()
        let group = DispatchGroup()

        for (ident, opts, unit, key, scale) in specs {
            guard let qt = HKObjectType.quantityType(forIdentifier: ident) else { continue }
            group.enter()
            let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
            let q = HKStatisticsCollectionQuery(quantityType: qt, quantitySamplePredicate: pred,
                                                options: opts, anchorDate: cal.startOfDay(for: end),
                                                intervalComponents: DateComponents(day: 1))
            q.initialResultsHandler = { _, results, _ in
                results?.enumerateStatistics(from: start, to: end) { stats, _ in
                    let qty = (opts == .cumulativeSum) ? stats.sumQuantity() : stats.averageQuantity()
                    guard let v = qty?.doubleValue(for: unit), v > 0 else { return }
                    let day = fmt.string(from: stats.startDate)
                    lock.lock(); byDay[day, default: [:]][key] = (v * scale).rounded() / scale; lock.unlock()
                }
                group.leave()
            }
            store.execute(q)
        }

        group.notify(queue: .main) {
            let daysOut = byDay.keys.sorted().map { day -> [String: Any] in
                var row: [String: Any] = ["day": day]
                for (k, v) in byDay[day] ?? [:] { row[k] = v }
                return row
            }
            call.resolve(["days": daysOut])
        }
    }

    // Logged workouts for the last N days: [{day, type, minutes, kcal}].
    @objc func getWorkouts(_ call: CAPPluginCall) {
        let days = max(1, min(60, call.getInt("days") ?? 14))
        let cal = Calendar.current
        let start = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: Date()))!
        let pred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone.current
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: pred, limit: 200, sortDescriptors: [sort]) { _, samples, _ in
            let out: [[String: Any]] = ((samples as? [HKWorkout]) ?? []).map { w in
                var kcal = 0.0
                if #available(iOS 16.0, *) {
                    if let t = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
                       let s = w.statistics(for: t)?.sumQuantity() { kcal = s.doubleValue(for: .kilocalorie()) }
                } else {
                    kcal = w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) ?? 0
                }
                return [
                    "day": fmt.string(from: w.startDate),
                    "type": Self.workoutName(w.workoutActivityType),
                    "minutes": Int((w.duration / 60).rounded()),
                    "kcal": Int(kcal.rounded()),
                ]
            }
            DispatchQueue.main.async { call.resolve(["workouts": out]) }
        }
        store.execute(q)
    }

    private static func workoutName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength"
        case .running: return "run"
        case .walking: return "walk"
        case .cycling: return "cycle"
        case .swimming: return "swim"
        case .highIntensityIntervalTraining: return "hiit"
        case .yoga: return "yoga"
        case .flexibility: return "stretch"
        case .elliptical: return "elliptical"
        case .rowing: return "rowing"
        case .stairClimbing: return "stairs"
        case .coreTraining: return "core"
        case .pilates: return "pilates"
        case .dance, .cardioDance: return "dance"
        case .kickboxing, .boxing: return "boxing"
        case .hiking: return "hike"
        default: return "workout"
        }
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
