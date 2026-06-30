import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var didRegisterPlugins = false
    private var pluginRegisterAttempts = 0

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        registerLocalPlugins()   // start trying immediately; it retries until the bridge is ready
        return true
    }

    // Register our LOCAL VoiceCapture plugin on the bridge once the root bridge
    // controller is up. Done from the AppDelegate (not a storyboard subclass) to
    // avoid storyboard class-resolution issues. The bridge may not exist the instant
    // we're first called, so RETRY on a short timer until it is — otherwise the
    // plugin silently never registers and JS sees "not implemented on iOS".
    private func registerLocalPlugins() {
        configureWebView()   // also lock the scroll view / dark background once the web view is up
        guard !didRegisterPlugins else { return }
        if let vc = window?.rootViewController as? CAPBridgeViewController, let bridge = vc.bridge {
            bridge.registerPluginInstance(VoiceCapturePlugin())
            didRegisterPlugins = true
            return
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
