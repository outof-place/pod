import Foundation
import XPC

/// A device's `com.apple.CoreSimulator.accessibility` service as an endpoint kept for the device's
/// session: one `-[SimDevice lookup:error:]` (a CoreSimulatorService call, which stalls when many
/// tools call it), then connections made from it locally in microseconds. CoreSimulatorBridge answers
/// each connection's requests in order and different connections at once, and it pushes every
/// accessibility notification of the device to each connection that has sent a request; so a walk's
/// extra lanes live for that walk only, and one kept connection hears the notifications.
/// The `_4sim` calls are the ones SimXPCService resolves (idb v1.7.2 `SimulatorXPCConnection`, MIT).
final class AXBridgeEndpoint: @unchecked Sendable {
    private struct Calls {
        typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
        typealias ConnectionFromEndpoint = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
        typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void
        let endpoint: EndpointFromPort
        let connection: ConnectionFromEndpoint
        let sim2host: EnableSim2Host

        static let resolved: Calls? = {
            let handle = dlopen(nil, RTLD_NOW)
            guard let endpoint = dlsym(handle, "xpc_endpoint_create_mach_port_4sim"),
                  let connection = dlsym(handle, "xpc_connection_create_from_endpoint"),
                  let sim2host = dlsym(handle, "xpc_connection_enable_sim2host_4sim")
            else { return nil }
            return Calls(
                endpoint: unsafeBitCast(endpoint, to: EndpointFromPort.self),
                connection: unsafeBitCast(connection, to: ConnectionFromEndpoint.self),
                sim2host: unsafeBitCast(sim2host, to: EnableSim2Host.self))
        }()
    }

    private let endpoint: xpc_object_t
    private let calls: Calls

    private init(endpoint: xpc_object_t, calls: Calls) {
        self.endpoint = endpoint
        self.calls = calls
    }

    static func lookup(_ device: SimDeviceHandle) -> Result<AXBridgeEndpoint, HelperError> {
        guard let calls = Calls.resolved else {
            return .failure(HelperError(.failed, "libxpc has no _4sim endpoint calls on this macOS"))
        }
        let service = AXBridgeTransport.service
        let looked = ObjCGuard.attempt("-[SimDevice lookup:error:]") { () -> Result<mach_port_t, HelperError> in
            typealias Lookup = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> UInt32
            let selector = NSSelectorFromString("lookup:error:")
            var error: NSError?
            let port = unsafeBitCast(device.object.method(for: selector), to: Lookup.self)(device.object, selector, service as NSString, &error)
            guard port != 0 else {
                return .failure(HelperError(.failed, "no \(service) in \(device.name): \(error?.localizedDescription ?? "lookup answered 0")"))
            }
            return .success(port)
        }.flatMap { $0 }
        return looked.flatMap { port in
            // +1, as SimXPCService takes it.
            guard let endpoint = calls.endpoint(port, 0, 0)?.takeRetainedValue() as? xpc_object_t else {
                return .failure(HelperError(.failed, "libxpc made no endpoint for \(service)"))
            }
            return .success(AXBridgeEndpoint(endpoint: endpoint, calls: calls))
        }
    }

    /// A resumed connection; every message that is not a reply goes to `onEvent` on `queue`.
    func connect(queue: DispatchQueue, onEvent: @escaping @Sendable (xpc_object_t) -> Void) -> AXBridgeLane? {
        guard let connection = calls.connection(endpoint)?.takeRetainedValue() as? xpc_connection_t else { return nil }
        calls.sim2host(connection)
        xpc_connection_set_target_queue(connection, queue)
        xpc_connection_set_event_handler(connection, onEvent)
        xpc_connection_resume(connection)
        return AXBridgeLane(connection: connection)
    }
}

/// One connection to a device's accessibility service, with at most one request in flight: the
/// service answers a connection's requests in order, so a second one would only queue behind it.
final class AXBridgeLane: @unchecked Sendable {
    let connection: xpc_connection_t
    private let queue = DispatchQueue(label: "pod-sim.ax.lane", qos: .userInitiated)
    private let lock = NSLock()
    private var pending: (@Sendable (NSObject?) -> Void)?
    private var generation = 0
    // Disarmed between requests: a lane at rest never wakes.
    private let timer: DispatchSourceTimer

    init(connection: xpc_connection_t) {
        self.connection = connection
        timer = DispatchSource.makeTimerSource(queue: queue)
        timer.setEventHandler { [weak self] in self?.expire() }
        timer.schedule(deadline: .distantFuture)
        timer.activate()
    }

    /// Sends one archived translator request; `done` gets the decoded response once, nil when it did
    /// not come within `timeout` or the connection failed (the translator reads that as no value).
    func send(_ request: NSObject, timeout: TimeInterval, done: @escaping @Sendable (NSObject?) -> Void) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: request, requiringSecureCoding: true) else {
            done(nil)
            return
        }
        let sent = lock.withLock { () -> Int in
            pending = done
            generation += 1
            return generation
        }
        timer.schedule(deadline: .now() + timeout)
        xpc_connection_send_message_with_reply(connection, AXBridgeTransport.envelope(data), queue) { [weak self] reply in
            self?.finish(sent, xpc_get_type(reply) == XPC_TYPE_ERROR ? nil : AXBridgeTransport.response(reply) as? NSObject)
        }
    }

    private func finish(_ sent: Int, _ response: NSObject?) {
        let taken = lock.withLock { () -> (@Sendable (NSObject?) -> Void)? in
            guard sent == generation, let callback = pending else { return nil }
            pending = nil
            return callback
        }
        guard let taken else { return }
        timer.schedule(deadline: .distantFuture)
        taken(response)
    }

    private func expire() {
        finish(lock.withLock { generation }, nil)
    }

    func cancel() {
        xpc_connection_cancel(connection)
        timer.cancel()
        finish(lock.withLock { generation }, nil)
    }
}
