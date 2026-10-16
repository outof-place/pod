import Foundation

/// The only place that loads CoreSimulator and SimulatorKit, and only for a build the version table
/// knows. Everything after goes through the Objective-C runtime; the binary links neither.
enum PrivateFrameworks {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var loaded: [String: Result<Void, HelperError>] = [:]

    /// Loads both frameworks once per process; the same answer every later call.
    static func load(_ facts: EnvironmentFacts) -> Result<Void, HelperError> {
        guard let coreSimulator = facts.coreSimulator, let simulatorKit = facts.simulatorKit else {
            return .failure(HelperError(.unsupported, facts.problem ?? "no Xcode"))
        }
        let key = "\(coreSimulator.path)|\(simulatorKit.path)"
        return lock.withLock {
            if let earlier = loaded[key] { return earlier }
            let result = open(coreSimulator.path + "/CoreSimulator").flatMap { open(simulatorKit.path + "/SimulatorKit") }
            loaded[key] = result
            return result
        }
    }

    private static func open(_ binary: String) -> Result<Void, HelperError> {
        guard dlopen(binary, RTLD_NOW) != nil else {
            let reason = dlerror().map { String(cString: $0) } ?? "unknown error"
            return .failure(HelperError(.failed, "dlopen \(binary): \(reason)"))
        }
        return .success(())
    }

    /// Classes and selectors the display and screenshot paths call; each was seen in CoreSimulator
    /// 1171.7 (stage 0 spike and this helper). The display descriptor is a remote proxy, so its
    /// selectors are checked on the device, not here.
    static func missingSymbols(deviceSetOverride: Bool) -> [String] {
        var missing: [String] = []
        func instance(_ className: String, _ selectors: [String]) {
            guard let cls = NSClassFromString(className) else {
                missing.append(className)
                return
            }
            for name in selectors where !cls.instancesRespond(to: NSSelectorFromString(name)) {
                missing.append("-[\(className) \(name)]")
            }
        }
        if let context = NSClassFromString("SimServiceContext") {
            let selector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
            if !(context as AnyObject).responds(to: selector) { missing.append("+[SimServiceContext sharedServiceContextForDeveloperDir:error:]") }
        }
        instance("SimServiceContext", deviceSetOverride ? ["deviceSetWithPath:error:"] : ["defaultDeviceSetWithError:"])
        instance("SimDeviceSet", ["devices"])
        instance("SimDevice", ["UDID", "name", "stateString", "deviceType", "io"])
        instance("SimDeviceType", ["mainScreenSize", "mainScreenScale"])
        instance("SimDeviceIOClient", ["updateIOPorts", "deviceIOPorts"])
        return missing
    }
}
