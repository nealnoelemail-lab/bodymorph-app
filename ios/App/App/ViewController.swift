import UIKit
import Capacitor

// Subclass the Capacitor bridge controller so we can register our LOCAL plugin
// (Capacitor only auto-discovers plugins shipped as packages). @objc(...) gives the
// class a stable Objective-C name so the storyboard can resolve it by that name
// WITHOUT a module qualifier — avoiding the mangled-name mismatch that left the
// WebView blank.
@objc(BMBridgeViewController)
class BMBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceCapturePlugin())
    }
}
