import CoreGraphics
import Foundation

/// How the frontmost app's interface stands on the device's native (portrait) screen, as far as the
/// tree tells: the application element spans the screen in the app's orientation (a split-view iPad
/// app spans its full height), so its size says portrait or landscape. Left from right and upside
/// down it cannot tell.
public enum InterfaceOrientation: String, Codable, Sendable {
    case portrait, landscape

    /// nil when the root fits neither way (a Slide Over or Stage Manager window).
    static func of(root: CGSize, native: CGSize) -> InterfaceOrientation? {
        func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) <= 1 }
        guard root.width > 0, root.height > 0, native.width > 0, native.height > 0 else { return nil }
        if near(root.height, native.height), root.width <= native.width + 1 { return .portrait }
        if near(root.height, native.width), root.width <= native.height + 1 { return .landscape }
        return nil
    }
}

/// Each device's orientation as its latest `ax` snapshot saw it, so `hid` can refuse points it would
/// send to the wrong place. Kept per device object: a reboot starts unknown.
final class DeviceOrientations: @unchecked Sendable {
    static let shared = DeviceOrientations()

    private let lock = NSLock()
    private var seen: [String: (device: NSObject, orientation: InterfaceOrientation?)] = [:]

    func record(_ orientation: InterfaceOrientation?, for device: SimDeviceHandle) {
        lock.withLock { seen[device.udid] = (device.object, orientation) }
    }

    func latest(_ device: SimDeviceHandle) -> InterfaceOrientation? {
        lock.withLock {
            guard let kept = seen[device.udid], kept.device === device.object else { return nil }
            return kept.orientation
        }
    }
}

/// `hid` sends device points to the digitizer as portrait, the native screen's space. In landscape
/// the tree's points are the interface's, and their mapping onto the digitizer is not verified on a
/// device yet (stage 8), so actions that start a contact are refused rather than sent somewhere else.
/// A touch already down may still move and lift; keys, text and buttons carry no points.
enum OrientationGate {
    static func refusal(_ action: HIDAction, orientation: InterfaceOrientation?) -> HelperError? {
        guard orientation == .landscape else { return nil }
        switch action {
        case .touch(.move, _, _), .touch(.up, _, _), .text, .key, .button:
            return nil
        case .tap, .longPress, .swipe, .drag, .pinch, .touch(.down, _, _):
            return HelperError(
                .unsupported,
                "hid: the app was in landscape at this device's last ax snapshot, and hid sends points in portrait only until stage 8 verifies the landscape mapping; keys, text and buttons work, and a new ax snapshot in portrait lifts this")
        }
    }
}
