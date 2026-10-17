import CoreGraphics
import Foundation

/// A device as CoreSimulator reports it.
struct SimDeviceHandle: @unchecked Sendable {
    let object: NSObject
    let udid: String
    let name: String
    let state: String
    /// Pixels of the main screen, from the device type.
    let screenPixels: CGSize

    var isBooted: Bool { state == "Booted" }

    /// When this boot started: another value than an attachment saw means the device rebooted since.
    var lastBootedAt: Date? {
        let selector = NSSelectorFromString("lastBootedAt")
        guard object.responds(to: selector) else { return nil }
        let read = ObjCGuard.attempt("lastBootedAt") { object.value(forKey: "lastBootedAt") as? Date }
        guard case .success(let date) = read else { return nil }
        return date
    }
}

/// CoreSimulator's service context and a device set: the default one (what simctl, Xcode and the
/// pool use) unless `POD_SIM_DEVICE_SET` names another (probes, so a running Simulator.app, which
/// watches only the default set, opens no window for their devices).
final class SimulatorService: @unchecked Sendable {
    private let deviceSet: NSObject

    private init(deviceSet: NSObject) {
        self.deviceSet = deviceSet
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var shared: [String: SimulatorService] = [:]

    static func shared(developerDir: String, deviceSetPath: String?) -> Result<SimulatorService, HelperError> {
        let key = "\(developerDir)|\(deviceSetPath ?? "")"
        return lock.withLock {
            if let existing = shared[key] { return .success(existing) }
            let made = make(developerDir: developerDir, deviceSetPath: deviceSetPath)
            if case .success(let service) = made { shared[key] = service }
            return made
        }
    }

    private static func make(developerDir: String, deviceSetPath: String?) -> Result<SimulatorService, HelperError> {
        guard let contextClass = NSClassFromString("SimServiceContext") else {
            return .failure(HelperError(.failed, "SimServiceContext is missing"))
        }
        typealias ContextFn = @convention(c) (AnyClass, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
        typealias SetFn = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
        typealias SetAtPathFn = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
        // CoreSimulator caches sets by fully resolved path (idb v1.7.2 SimulatorServiceContext).
        let resolvedSet = deviceSetPath.map { path in
            var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
            return realpath(path, &buffer).map { String(cString: $0) } ?? path
        }
        return ObjCGuard.attempt("SimServiceContext") { () -> Result<SimulatorService, HelperError> in
            var error: NSError?
            let contextSelector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
            guard let method = class_getClassMethod(contextClass, contextSelector) else {
                return .failure(HelperError(.failed, "+[SimServiceContext sharedServiceContextForDeveloperDir:error:] is missing"))
            }
            let context = unsafeBitCast(method_getImplementation(method), to: ContextFn.self)(contextClass, contextSelector, developerDir as NSString, &error)
            guard let context = context as? NSObject else {
                return .failure(HelperError(.failed, "no service context for \(developerDir): \(error?.localizedDescription ?? "nil")"))
            }
            let set: AnyObject?
            if let resolvedSet {
                let selector = NSSelectorFromString("deviceSetWithPath:error:")
                set = unsafeBitCast(context.method(for: selector), to: SetAtPathFn.self)(context, selector, resolvedSet as NSString, &error)
            } else {
                let selector = NSSelectorFromString("defaultDeviceSetWithError:")
                set = unsafeBitCast(context.method(for: selector), to: SetFn.self)(context, selector, &error)
            }
            guard let set = set as? NSObject else {
                return .failure(HelperError(.failed, "no device set \(resolvedSet ?? "(default)"): \(error?.localizedDescription ?? "nil")"))
            }
            return .success(SimulatorService(deviceSet: set))
        }.flatMap { $0 }
    }

    func device(udid: String) -> Result<SimDeviceHandle, HelperError> {
        ObjCGuard.attempt("SimDeviceSet.devices") { () -> Result<SimDeviceHandle, HelperError> in
            let devices = deviceSet.value(forKey: "devices") as? [NSObject] ?? []
            guard let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid.uppercased() }) else {
                return .failure(HelperError(.deviceNotFound, "no simulator \(udid) in this device set"))
            }
            return .success(SimDeviceHandle(
                object: device,
                udid: udid.uppercased(),
                name: device.value(forKey: "name") as? String ?? "",
                state: device.value(forKey: "stateString") as? String ?? "",
                screenPixels: Self.screenPixels(device)))
        }.flatMap { $0 }
    }

    private static func screenPixels(_ device: NSObject) -> CGSize {
        guard let type = device.value(forKey: "deviceType") as? NSObject else { return .zero }
        typealias SizeFn = @convention(c) (AnyObject, Selector) -> CGSize
        let selector = NSSelectorFromString("mainScreenSize")
        guard type.responds(to: selector) else { return .zero }
        return unsafeBitCast(type.method(for: selector), to: SizeFn.self)(type, selector)
    }
}
