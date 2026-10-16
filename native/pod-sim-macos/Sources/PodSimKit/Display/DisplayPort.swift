import CoreGraphics
import Foundation
import IOSurface

/// CoreSimDeviceIO's `SimScreen` callbacks (idb v1.7.2 PrivateHeaders/CoreSimDeviceIO/SimScreen-Protocol.h):
/// `surfacesChanged` gets (framebufferSurface, maskedFramebufferSurface), `propertiesChanged` one object.
@objc protocol PodSimScreenCallbacks {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(
        uuid: UUID, callbackQueue: DispatchQueue,
        frameCallback: @escaping () -> Void,
        surfacesChangedCallback: @escaping (Any?, Any?) -> Void,
        propertiesChangedCallback: @escaping (Any?) -> Void)
    @objc(unregisterScreenCallbacksWithUUID:)
    func unregisterScreenCallbacks(uuid: UUID)
}

/// SimDisplayDescriptorState (idb v1.7.2 PrivateHeaders/CoreSimDeviceIO/SimDisplayDescriptorState-Protocol.h).
@objc protocol PodSimDisplayState {
    var displayClass: UInt16 { get }
}

/// The main display of one booted device: its IO-port descriptor, a CoreSimulator remote proxy whose
/// every call is guarded (a moved selector raises instead of returning).
final class DisplayPort: @unchecked Sendable {
    static let framebufferPortIdentifier = "com.apple.framebuffer.display"

    let udid: String
    /// Which port won and what the others were, for the self-test's note.
    let selection: String
    private let descriptor: NSObject

    private init(udid: String, descriptor: NSObject, selection: String) {
        self.udid = udid
        self.descriptor = descriptor
        self.selection = selection
    }

    static func main(of device: SimDeviceHandle) -> Result<DisplayPort, HelperError> {
        guard device.isBooted else {
            return .failure(HelperError(.deviceNotBooted, "\(device.name) (\(device.udid)) is \(device.state), not Booted"))
        }
        return ObjCGuard.attempt("SimDevice.io ports") { () -> Result<DisplayPort, HelperError> in
            guard let io = device.object.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
                return .failure(HelperError(.failed, "SimDevice has no io client"))
            }
            io.perform(NSSelectorFromString("updateIOPorts"))
            let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] ?? []
            var descriptors: [NSObject] = []
            var candidates: [DisplayCandidate] = []
            for port in ports {
                guard let identifier = port.perform(NSSelectorFromString("portIdentifier"))?.takeUnretainedValue(),
                      "\(identifier)" == framebufferPortIdentifier,
                      let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
                      descriptor.responds(to: NSSelectorFromString("framebufferSurface"))
                else { continue }
                let surface = surfaceRef(descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue())
                descriptors.append(descriptor)
                candidates.append(DisplayCandidate(
                    displayClass: displayClass(of: descriptor),
                    width: surface.map(IOSurfaceGetWidth), height: surface.map(IOSurfaceGetHeight)))
            }
            let pixels = (Int(device.screenPixels.width), Int(device.screenPixels.height))
            guard let index = MainDisplaySelection.pick(candidates, devicePixels: pixels) else {
                return .failure(HelperError(.failed, "no main display among \(candidates.count) framebuffer ports of \(device.name)"))
            }
            let seen = candidates.map { c in
                "class \(c.displayClass.map(String.init) ?? "?") \(c.width.map { "\($0)x\(c.height ?? 0)" } ?? "no surface")"
            }
            let selection = "port \(index + 1) of \(candidates.count) [\(seen.joined(separator: "; "))]"
            return .success(DisplayPort(udid: device.udid, descriptor: descriptors[index], selection: selection))
        }.flatMap { $0 }
    }

    /// The live framebuffer, rewritten in place by CoreSimulator (one surface per device, stage 0).
    func surface() -> IOSurfaceRef? {
        let read = ObjCGuard.attempt("framebufferSurface") {
            descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue()
        }
        guard case .success(let object) = read else { return nil }
        return Self.surfaceRef(object)
    }

    func registerCallbacks(
        token: UUID, queue: DispatchQueue,
        onFrame: @escaping @Sendable () -> Void,
        onSurface: @escaping @Sendable (IOSurfaceRef?) -> Void
    ) -> Result<Void, HelperError> {
        let screen = descriptor as AnyObject
        return ObjCGuard.attempt("registerScreenCallbacksWithUUID:") {
            screen.registerScreenCallbacks(
                uuid: token, callbackQueue: queue,
                frameCallback: { onFrame() },
                surfacesChangedCallback: { framebuffer, _ in onSurface(Self.surfaceRef(framebuffer)) },
                propertiesChangedCallback: { _ in })
        }
    }

    func unregisterCallbacks(token: UUID) {
        let screen = descriptor as AnyObject
        _ = ObjCGuard.attempt("unregisterScreenCallbacksWithUUID:") { screen.unregisterScreenCallbacks(uuid: token) }
    }

    static func surfaceRef(_ object: Any?) -> IOSurfaceRef? {
        guard let object = object as AnyObject?, CFGetTypeID(object as CFTypeRef) == IOSurfaceGetTypeID() else { return nil }
        return unsafeDowncast(object, to: IOSurfaceRef.self)
    }

    /// `-[descriptor state].displayClass` (SimDisplayDescriptorState) as a message: the state is a
    /// ROCK proxy that answers `respondsToSelector:` yet raises on KVC (seen on CoreSimulator 1171.7).
    /// nil when it raises, so the size rule decides.
    private static func displayClass(of descriptor: NSObject) -> UInt16? {
        let read = ObjCGuard.attempt("displayClass") { () -> UInt16? in
            guard descriptor.responds(to: NSSelectorFromString("state")),
                  let state = descriptor.perform(NSSelectorFromString("state"))?.takeUnretainedValue()
            else { return nil }
            return (state as AnyObject).displayClass
        }
        guard case .success(let value) = read else { return nil }
        return value
    }
}
