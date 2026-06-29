import UIKit
import Capacitor

// Subclass the Capacitor bridge controller so we can register our LOCAL plugin.
// Capacitor only auto-discovers plugins shipped as packages; a plugin defined in
// the app target (VoiceCapture) must be registered by hand here.
class ViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceCapturePlugin())
    }
}
