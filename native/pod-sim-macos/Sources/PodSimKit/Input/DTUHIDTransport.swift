import Foundation
import XPC

/// One host XPC connection to a booted device's `dtuhidd` digitizer service, the only input path
/// that works on CoreSimulator 1171.7 (stage 0: Indigo delivered 0 of 20 taps). The wire is idb
/// v1.7.2's (`SimulatorDTUHIDConnection`, `DTUHIDModels`; MIT, see THIRD_PARTY_NOTICES.md):
/// envelopes `{messageType, isBarrier, featureIdentifier, payload}` whose numbers ride as uint64.
final class DTUHIDTransport: @unchecked Sendable {
    static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
    /// A connect-time liveness reply demand-launches `dtuhidd`; idb allows 4 s.
    static let livenessTimeout: TimeInterval = 4
    /// After a fresh connect's first reply the device still opens its HID device: idb v1.7.2 waits
    /// `DTUHIDTiming.replyTail` (200 ms) before the first event, so a cold first tap is not dropped.
    static let replyTailMs: UInt32 = 200

    private var connection: xpc_connection_t?
    private let lock = NSLock()
    private var broken: String?

    static func missingSymbols() -> [String] { SimXPCService.missingSymbols() }

    /// Connects and proves a live `dtuhidd` answers a barrier: a service port is handed out even for a
    /// daemon that aborted during boot, and sends to it vanish without an error (idb v1.7.2).
    static func connect(_ device: SimDeviceHandle) -> Result<DTUHIDTransport, HelperError> {
        let transport = DTUHIDTransport()
        let connected = SimXPCService.connect(
            device, service: service, queue: DispatchQueue(label: "pod-sim.dtuhid.\(device.udid)"),
            onError: { [weak transport] reason in transport?.markBroken(reason) })
        switch connected {
        case .failure(let error): return .failure(error)
        case .success(let connection): transport.connection = connection
        }
        guard transport.barrier(timeout: livenessTimeout) else {
            transport.close()
            return .failure(HelperError(.failed, "dtuhidd in \(device.name) did not answer within \(Int(livenessTimeout)) s (the device may still be starting)"))
        }
        usleep(replyTailMs * 1_000)
        return .success(transport)
    }

    /// Why this connection can no longer be used, once XPC said so.
    var brokenReason: String? { lock.withLock { broken } }

    private func markBroken(_ reason: String) {
        lock.withLock { broken = broken ?? reason }
    }

    func close() {
        markBroken("closed")
        if let connection { xpc_connection_cancel(connection) }
    }

    /// A barrier carrying usage 0 ("no event"): the daemon answers once everything sent before it
    /// was handled, and the device sees no key.
    func barrier(timeout: TimeInterval) -> Bool {
        guard let connection else { return false }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usageCode", 0)
        xpc_dictionary_set_uint64(payload, "state", HIDButtonState.up.rawValue)
        return SimXPCService.request(connection, envelope("IndigoKeyboardButtonEvent", payload, barrier: true), timeout: timeout) != nil
    }

    func send(_ event: DTUHIDEvent) {
        guard let connection else { return }
        let payload = xpc_dictionary_create(nil, nil, 0)
        let type: String
        switch event {
        case .digitizer(let contact):
            xpc_dictionary_set_value(payload, "pointOne", point(contact.first))
            if let second = contact.second { xpc_dictionary_set_value(payload, "pointTwo", point(second)) }
            xpc_dictionary_set_uint64(payload, "eventType", contact.phase.rawValue)
            xpc_dictionary_set_uint64(payload, "edge", contact.edge.rawValue)
            xpc_dictionary_set_uint64(payload, "target", 0)
            type = "IndigoDigitizerEvent"
        case .key(let usage, let state):
            xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
            xpc_dictionary_set_uint64(payload, "state", state.rawValue)
            type = "IndigoKeyboardButtonEvent"
        case .button(let page, let usage, let state):
            xpc_dictionary_set_uint64(payload, "usagePage", UInt64(page))
            xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
            xpc_dictionary_set_uint64(payload, "state", state.rawValue)
            type = "IndigoButtonEvent"
        }
        xpc_connection_send_message(connection, envelope(type, payload))
    }

    private func envelope(_ type: String, _ payload: xpc_object_t, barrier: Bool = false) -> xpc_object_t {
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", type)
        xpc_dictionary_set_bool(message, "isBarrier", barrier)
        xpc_dictionary_set_string(message, "featureIdentifier", Self.service)
        xpc_dictionary_set_value(message, "payload", payload)
        return message
    }

    private func point(_ point: NormalizedPoint) -> xpc_object_t {
        let value = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_double(value, "x", point.x)
        xpc_dictionary_set_double(value, "y", point.y)
        return value
    }
}
