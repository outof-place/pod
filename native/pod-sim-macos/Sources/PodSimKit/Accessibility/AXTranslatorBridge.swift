import AppKit
import Foundation

/// AccessibilityPlatformTranslation's `AXPTranslator`, the macOS framework Simulator itself uses to
/// read an iOS device's accessibility tree. The translator is a process-wide singleton with
/// unsynchronized state (idb v1.7.2 `AXTranslationDispatcher`: concurrent walks over-release its token
/// storage), so every touch of it or its elements runs on one serial queue, and each walk carries a
/// token that routes the translator's requests to its own device. Loaded on first use only.
final class AXTranslatorBridge: NSObject, @unchecked Sendable {
    static let frameworkPath = "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation"

    /// Where every translator call runs, process-wide.
    static let queue = DispatchQueue(label: "pod-sim.ax.translator", qos: .userInitiated)

    /// Where one walk's requests go, and how many went unanswered.
    final class Route: @unchecked Sendable {
        let transport: AXTransport
        let requestTimeout: TimeInterval
        private let lock = NSLock()
        private var counts = (sent: 0, unanswered: 0, nanos: UInt64(0))

        init(transport: AXTransport, requestTimeout: TimeInterval) {
            self.transport = transport
            self.requestTimeout = requestTimeout
        }

        func send(_ request: AnyObject) -> AnyObject? {
            let started = DispatchTime.now().uptimeNanoseconds
            let response = transport.send(request, timeout: requestTimeout)
            let took = DispatchTime.now().uptimeNanoseconds - started
            lock.withLock {
                counts.sent += 1
                counts.nanos += took
                if response == nil { counts.unanswered += 1 }
            }
            return response
        }

        var sent: Int { lock.withLock { counts.sent } }
        /// Time spent waiting on the transport (the round trips to the device), in ms.
        var transportMs: Double { lock.withLock { Double(counts.nanos) / 1_000_000 } }
        var unanswered: Int { lock.withLock { counts.unanswered } }
    }

    private let lock = NSLock()
    private var routes: [String: Route] = [:]
    private(set) var translator: NSObject?

    private static let loadLock = NSLock()
    nonisolated(unsafe) private static var loaded: Result<AXTranslatorBridge, HelperError>?

    /// The installed bridge, loading the framework once per process; the same answer every later call.
    static func shared() -> Result<AXTranslatorBridge, HelperError> {
        loadLock.withLock {
            if let loaded { return loaded }
            let made = make()
            loaded = made
            return made
        }
    }

    private static func make() -> Result<AXTranslatorBridge, HelperError> {
        guard dlopen(frameworkPath, RTLD_NOW) != nil else {
            let reason = dlerror().map { String(cString: $0) } ?? "unknown error"
            return .failure(HelperError(.failed, "dlopen AccessibilityPlatformTranslation: \(reason)"))
        }
        if let missing = missingSymbols().first {
            return .failure(HelperError(.failed, "AccessibilityPlatformTranslation lacks \(missing)"))
        }
        let bridge = AXTranslatorBridge()
        return ObjCGuard.attempt("AXPTranslator sharedInstance") { () -> Result<AXTranslatorBridge, HelperError> in
            guard let cls = NSClassFromString("AXPTranslator") as? NSObject.Type,
                  let translator = cls.perform(NSSelectorFromString("sharedInstance"))?.takeUnretainedValue() as? NSObject
            else { return .failure(HelperError(.failed, "+[AXPTranslator sharedInstance] answered nothing")) }
            // Token delegation, as idb does: one translator serves every device by token.
            translator.setValue(bridge, forKey: "bridgeTokenDelegate")
            translator.setValue(true, forKey: "supportsDelegateTokens")
            translator.setValue(true, forKey: "accessibilityEnabled")
            bridge.translator = translator
            return .success(bridge)
        }.flatMap { $0 }
    }

    /// Selectors the walk calls; each was seen on macOS 27.0.1 (26A434), framework build 587.
    static func missingSymbols() -> [String] {
        var missing: [String] = []
        guard let translator = NSClassFromString("AXPTranslator") else { return ["AXPTranslator"] }
        if !(translator as AnyObject).responds(to: NSSelectorFromString("sharedInstance")) { missing.append("+[AXPTranslator sharedInstance]") }
        for name in ["frontmostApplicationWithDisplayId:bridgeDelegateToken:", "macPlatformElementFromTranslation:",
                     "objectAtPoint:displayId:bridgeDelegateToken:", "setBridgeTokenDelegate:", "setSupportsDelegateTokens:",
                     "setAccessibilityEnabled:"]
        where !translator.instancesRespond(to: NSSelectorFromString(name)) {
            missing.append("-[AXPTranslator \(name)]")
        }
        if NSClassFromString("AXPTranslationObject") == nil { missing.append("AXPTranslationObject") }
        if let element = NSClassFromString("AXPMacPlatformElement") {
            if !element.instancesRespond(to: NSSelectorFromString("accessibilityMultipleAttributes:")) {
                missing.append("-[AXPMacPlatformElement accessibilityMultipleAttributes:]")
            }
        } else {
            missing.append("AXPMacPlatformElement")
        }
        if let response = NSClassFromString("AXPTranslatorResponse") {
            if !(response as AnyObject).responds(to: NSSelectorFromString("emptyResponse")) { missing.append("+[AXPTranslatorResponse emptyResponse]") }
        } else {
            missing.append("AXPTranslatorResponse")
        }
        if let device = NSClassFromString("SimDevice"),
           !device.instancesRespond(to: NSSelectorFromString("sendAccessibilityRequestAsync:completionQueue:completionHandler:")) {
            missing.append("-[SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:]")
        }
        return missing
    }

    /// A token routed to `transport` for the length of one walk.
    func register(_ transport: AXTransport, requestTimeout: TimeInterval) -> (token: String, route: Route) {
        let token = UUID().uuidString
        let route = Route(transport: transport, requestTimeout: requestTimeout)
        lock.withLock { routes[token] = route }
        return (token, route)
    }

    func unregister(_ token: String) {
        _ = lock.withLock { routes.removeValue(forKey: token) }
    }

    private func route(_ token: String) -> Route? {
        lock.withLock { routes[token] }
    }

    private static func emptyResponse() -> AnyObject? {
        (NSClassFromString("AXPTranslatorResponse") as? NSObject.Type)?.perform(NSSelectorFromString("emptyResponse"))?.takeUnretainedValue()
    }

    // MARK: - AXPTranslationTokenDelegateHelper (called by the translator, on the translator queue)

    // Tokens arrive optional: an element whose translation carries none must get no answer, not a trap.
    @objc(accessibilityTranslationDelegateBridgeCallbackWithToken:)
    func bridgeCallback(token: String?) -> AnyObject {
        guard let token, let route = route(token) else {
            let none: @convention(block) (AnyObject?) -> AnyObject? = { _ in AXTranslatorBridge.emptyResponse() }
            return none as AnyObject
        }
        let block: @convention(block) (AnyObject?) -> AnyObject? = { request in
            // Unanswered in time: the translator reads the empty response as "no value" (idb does the same).
            request.flatMap(route.send) ?? AXTranslatorBridge.emptyResponse()
        }
        return block as AnyObject
    }

    @objc(accessibilityTranslationConvertPlatformFrameToSystem:withToken:)
    func convertFrame(_ rect: NSRect, token: String?) -> NSRect { rect }

    @objc(accessibilityTranslationRootParentWithToken:)
    func rootParent(token: String?) -> AnyObject? { nil }
}
