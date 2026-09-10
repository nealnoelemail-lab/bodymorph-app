import UIKit
import Capacitor
import AVFoundation

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL PLUGIN REGISTRATION — must finish BEFORE the web view loads any JS.
//
// This used to run on a retry timer from the AppDelegate, which is a RACE we lost:
// @capacitor/core resolves a plugin ONCE, on first use, and caches the result. If any
// JS touched HealthKit before the timer got around to registering it, Capacitor cached
// "no native implementation" for the entire life of the app — so every later call,
// including a deliberate tap minutes afterwards, threw "not implemented on iOS".
// (Same family of bug as the barcode scanner: a plugin that never linked.)
//
// capacitorDidLoad() is Capacitor's designated hook for exactly this: the bridge
// exists, the web view has not loaded yet. No timer, no race, no cached failure.
// ══════════════════════════════════════════════════════════════════════════════
enum LocalPlugins {
    static private(set) var registered = false
    static func register(on bridge: CAPBridgeProtocol?) {
        guard !registered, let bridge = bridge else { return }
        bridge.registerPluginInstance(VoiceCapturePlugin())
        bridge.registerPluginInstance(HealthKitPlugin())
        registered = true
    }
}

// NO @objc(MainViewController) rename here. The storyboard is set to customModule="App"
// with customModuleProvider="target", so Interface Builder compiles a reference to the
// MANGLED Swift name (_TtC3App18MainViewController). An @objc rename would replace that
// name, IB's lookup would miss, and the app would launch a bare UIViewController — a
// blank screen. Leave the default mangled name so the two agree.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        LocalPlugins.register(on: bridge)
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var pluginRegisterAttempts = 0

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        registerLocalPlugins()   // safety net + web view styling; MainViewController is the real path
        return true
    }

    // BACKSTOP only. MainViewController.capacitorDidLoad() registers the plugins at the
    // correct moment; this covers the case where the storyboard somehow hands back a
    // plain CAPBridgeViewController. It also drives configureWebView(), which genuinely
    // does need to wait for the web view to exist.
    private func registerLocalPlugins() {
        configureWebView()   // lock the scroll view / dark background once the web view is up
        if let vc = window?.rootViewController as? CAPBridgeViewController {
            LocalPlugins.register(on: vc.bridge)
        }
        pluginRegisterAttempts += 1
        if pluginRegisterAttempts < 60 {   // ~15s of 0.25s retries, then give up
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.registerLocalPlugins() }
        }
    }

    // Stop the WebView from rubber-band overscrolling sideways (which dragged the whole
    // page left/right and revealed the WebView's default white background) and paint its
    // background dark so nothing white can ever show through. Vertical scrolling still
    // works; the page just can't drift horizontally.
    private func configureWebView() {
        guard let vc = window?.rootViewController as? CAPBridgeViewController,
              let webView = vc.webView else { return }
        let dark = UIColor(red: 10/255.0, green: 10/255.0, blue: 15/255.0, alpha: 1.0)  // #0a0a0f
        webView.isOpaque = true
        webView.backgroundColor = dark
        webView.scrollView.backgroundColor = dark
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
    }

    // Configure a record+playback audio session so the voice coach can listen and
    // speak at the same time, route to speaker/Bluetooth, and — paired with the
    // "audio" UIBackgroundMode — keep the mic alive when the screen dims/locks.
    private func configureAudioSession() {
        // Pre-set a record+playback category that DUCKS (lowers) other audio rather than
        // stopping it. CRUCIAL: do NOT activate the session here — activating at launch
        // seized audio and killed the user's music the instant they opened the app. The
        // voice coach (VoiceCapture) activates the session only when it actually starts,
        // and releases it (notifyOthersOnDeactivation) on stop, so music un-ducks/resumes.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord,
                                    mode: .spokenAudio,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers])
        } catch {
            print("[BodyMorph] audio session error: \(error)")
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Re-assert the audio session on return to foreground (it can be deactivated
        // by interruptions or when the screen was off).
        configureAudioSession()
        registerLocalPlugins()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
