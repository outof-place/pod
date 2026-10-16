import Foundation
import XPC

/// Carries one translator request to a device's accessibility service and brings back its answer,
/// waiting at most `timeout`. Two paths (idb v1.7.2 `AXTranslationTransport`, MIT):
/// - `bridge`: straight to `com.apple.CoreSimulator.accessibility`, which CoreSimulatorBridge vends in
///   the device: one archived request per message on one connection.
/// - `coreSimulator`: `-[SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:]`,
///   which hops through CoreSimulatorService (seen stalling over 10 s on this Mac while other tools
///   called it, 2026-10-16) and also pushes notifications into the translator off its queue.
/// The bridge is used when it connects; CoreSimulator's client otherwise.
protocol AXTransport: AnyObject, Sendable {
    var kind: String { get }
    var brokenReason: String? { get }
    func send(_ request: AnyObject, timeout: TimeInterval) -> AnyObject?
}

final class AXBridgeTransport: AXTransport, @unchecked Sendable {
    static let service = "com.apple.CoreSimulator.accessibility"
    static let payloadClassNameKey = "SimAccessibility_PayloadClassName"
    static let payloadKey = "SimAccessibility_Payload"
    static let requestKey = "translatorRequest"
    static let responseKey = "translatorResponse"

    let kind = "bridge"
    private var connection: xpc_connection_t?
    private let lock = NSLock()
    private var broken: String?

    static func connect(_ device: SimDeviceHandle) -> Result<AXBridgeTransport, HelperError> {
        let transport = AXBridgeTransport()
        let connected = SimXPCService.connect(
            device, service: service, queue: DispatchQueue(label: "pod-sim.ax.bridge.\(device.udid)"),
            onError: { [weak transport] reason in transport?.markBroken(reason) })
        return connected.map { connection in
            transport.connection = connection
            return transport
        }
    }

    var brokenReason: String? { lock.withLock { broken } }

    private func markBroken(_ reason: String) {
        lock.withLock { broken = broken ?? reason }
    }

    func close() {
        markBroken("closed")
        if let connection { xpc_connection_cancel(connection) }
    }

    func send(_ request: AnyObject, timeout: TimeInterval) -> AnyObject? {
        guard let connection, let data = try? NSKeyedArchiver.archivedData(withRootObject: request, requiringSecureCoding: true) else {
            return nil
        }
        guard let reply = SimXPCService.request(connection, Self.envelope(data), timeout: timeout) else { return nil }
        return Self.response(reply)
    }

    static func envelope(_ data: Data) -> xpc_object_t {
        let payload = xpc_dictionary_create(nil, nil, 0)
        data.withUnsafeBytes { bytes in
            xpc_dictionary_set_value(payload, requestKey, xpc_data_create(bytes.baseAddress, bytes.count))
        }
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, payloadClassNameKey, "AXPTranslatorRequest")
        xpc_dictionary_set_value(message, payloadKey, payload)
        return message
    }

    /// The archived `AXPTranslatorResponse` in a reply; nil for anything else.
    static func response(_ reply: xpc_object_t) -> AnyObject? {
        guard xpc_get_type(reply) == XPC_TYPE_DICTIONARY,
              let name = xpc_dictionary_get_string(reply, payloadClassNameKey), String(cString: name) == "AXPTranslatorResponse",
              let payload = xpc_dictionary_get_value(reply, payloadKey), xpc_get_type(payload) == XPC_TYPE_DICTIONARY
        else { return nil }
        var length = 0
        guard let bytes = xpc_dictionary_get_data(payload, responseKey, &length),
              let responseClass = NSClassFromString("AXPTranslatorResponse")
        else { return nil }
        guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: Data(bytes: bytes, count: length)) else { return nil }
        unarchiver.requiresSecureCoding = true
        defer { unarchiver.finishDecoding() }
        return unarchiver.decodeObject(of: [responseClass], forKey: NSKeyedArchiveRootObjectKey) as AnyObject?
    }
}

final class AXCoreSimulatorTransport: AXTransport, @unchecked Sendable {
    let kind = "coreSimulator"
    let brokenReason: String? = nil
    private let device: NSObject
    private let completions = DispatchQueue(label: "pod-sim.ax.coresimulator", qos: .userInitiated)

    init(device: NSObject) {
        self.device = device
    }

    func send(_ request: AnyObject, timeout: TimeInterval) -> AnyObject? {
        let answered = DispatchSemaphore(value: 0)
        let box = ObjectBox()
        let done: @convention(block) (AnyObject?) -> Void = { response in
            box.set(response)
            answered.signal()
        }
        let selector = NSSelectorFromString("sendAccessibilityRequestAsync:completionQueue:completionHandler:")
        typealias Send = @convention(c) (AnyObject, Selector, AnyObject, DispatchQueue, AnyObject) -> Void
        let device = self.device
        let sent = ObjCGuard.attempt("sendAccessibilityRequestAsync") {
            unsafeBitCast(device.method(for: selector), to: Send.self)(device, selector, request, completions, done as AnyObject)
        }
        guard case .success = sent, answered.wait(timeout: .now() + timeout) == .success else { return nil }
        return box.value
    }
}

/// One transport per device, kept while its device object and connection last.
final class AXTransports: @unchecked Sendable {
    static let shared = AXTransports()

    private let lock = NSLock()
    private var byDevice: [String: (device: NSObject, transport: AXTransport)] = [:]

    func transport(for device: SimDeviceHandle) -> AXTransport {
        if let kept = lock.withLock({ byDevice[device.udid] }), kept.device === device.object, kept.transport.brokenReason == nil {
            return kept.transport
        }
        let made: AXTransport
        switch AXBridgeTransport.connect(device) {
        case .success(let bridge): made = bridge
        case .failure(let error):
            HelperLog.note("ax \(device.udid): \(error.message); using CoreSimulator's client")
            made = AXCoreSimulatorTransport(device: device.object)
        }
        lock.withLock { byDevice[device.udid] = (device.object, made) }
        return made
    }

    /// After a walk whose requests went unanswered: the next one connects again.
    func discard(_ udid: String) {
        let gone = lock.withLock { byDevice.removeValue(forKey: udid) }
        (gone?.transport as? AXBridgeTransport)?.close()
    }
}

private final class ObjectBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: AnyObject?
    func set(_ object: AnyObject?) { lock.withLock { stored = object } }
    var value: AnyObject? { lock.withLock { stored } }
}
