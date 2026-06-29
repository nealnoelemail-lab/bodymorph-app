import UIKit
import Capacitor

// Subclass the Capacitor bridge controller so we can register our LOCAL plugin.
// Capacitor only auto-discovers plugins shipped as packages; a plugin defined in
// the app target (VoiceCapture) must be registered by hand here.
// @objc(ViewController) exposes it to the ObjC runtime so the storyboard can find
// it (a Swift class referenced only from a storyboard otherwise gets stripped →
// "Unknown class _TtC3App14ViewController in Interface Builder file").
@objc(ViewController)
class ViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceCapturePlugin())
    }
}
