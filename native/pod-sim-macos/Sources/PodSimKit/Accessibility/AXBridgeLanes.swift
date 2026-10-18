import Foundation
import XPC

/// A device's `com.apple.CoreSimulator.accessibility` service as an endpoint kept for the device's
/// session: one lookup (SimXPCService), then connections made from it locally in microseconds.
/// CoreSimulatorBridge answers each connection's requests in order and different connections at once,
/// and it pushes every accessibility notification of the device to each connection that has sent a
/// request; so a walk's extra lanes live for that walk only, and one kept connection hears the notifications.
final class AXBridgeEndpoint: @unchecked Sendable {
    private let endpoint: xpc_object_t

    private init(endpoint: xpc_object_t) {
        self.endpoint = endpoint
    }

    static func lookup(_ device: SimDeviceHandle) -> Result<AXBridgeEndpoint, HelperError> {
        SimXPCService.endpoint(device: device, service: AXBridgeTransport.service).map(AXBridgeEndpoint.init(endpoint:))
    }

    /// A resumed connection; every message that is not a reply goes to `onEvent` on `queue`.
    func connect(queue: DispatchQueue, onEvent: @escaping @Sendable (xpc_object_t) -> Void) -> AXBridgeLane? {
        SimXPCService.connection(from: endpoint, queue: queue, onEvent: onEvent).map(AXBridgeLane.init(connection:))
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
