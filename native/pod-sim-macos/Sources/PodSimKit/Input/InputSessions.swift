import Foundation

/// One warm DTUHID connection per device, so a tap costs its events and not a connect (stage 0: the
/// liveness barrier answers in milliseconds once the daemon runs, and up to seconds while it starts).
/// Each device has its own serial queue: events of one gesture never interleave with another's, and
/// a device whose connection hangs holds only its own queue.
final class InputSessions: @unchecked Sendable {
    static let shared = InputSessions()

    final class Session: @unchecked Sendable {
        let udid: String
        let transport: DTUHIDTransport
        let queue: DispatchQueue
        /// The device object the connection was made from; a reboot hands out another.
        let device: NSObject

        init(udid: String, transport: DTUHIDTransport, device: NSObject) {
            self.udid = udid
            self.transport = transport
            self.device = device
            queue = DispatchQueue(label: "pod-sim.input.\(udid)", qos: .userInteractive)
        }
    }

    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    // Connecting runs outside the lock, one at a time per device.
    private var connecting: [String: DispatchGroup] = [:]

    /// The device's session, connecting when there is none or the last one broke.
    func session(for device: SimDeviceHandle) -> Result<Session, HelperError> {
        while true {
            let step = lock.withLock { () -> (Session?, DispatchGroup?, DispatchGroup?) in
                if let existing = sessions[device.udid] {
                    if existing.transport.brokenReason == nil, existing.device === device.object { return (existing, nil, nil) }
                    sessions[device.udid] = nil
                    existing.transport.close()
                }
                if let busy = connecting[device.udid] { return (nil, busy, nil) }
                let mine = DispatchGroup()
                mine.enter()
                connecting[device.udid] = mine
                return (nil, nil, mine)
            }
            if let session = step.0 { return .success(session) }
            if let busy = step.1 {
                guard busy.wait(timeout: .now() + DTUHIDTransport.livenessTimeout + 1) == .success else {
                    return .failure(HelperError(.failed, "another call is still connecting to \(device.name)'s dtuhidd"))
                }
                continue
            }
            let mine = step.2!
            let connected = DTUHIDTransport.connect(device).map { Session(udid: device.udid, transport: $0, device: device.object) }
            lock.withLock {
                connecting[device.udid] = nil
                if case .success(let session) = connected { sessions[device.udid] = session }
            }
            mine.leave()
            return connected
        }
    }

    /// Drops a session that failed mid-call (a timeout, a broken connection): the next call reconnects.
    func discard(_ session: Session) {
        lock.withLock {
            if sessions[session.udid] === session { sessions[session.udid] = nil }
        }
        session.transport.close()
    }

    /// Sends the steps in order on the session's queue, waiting between them.
    func run(_ steps: [HIDStep], on session: Session, onFirstSend: (() -> Void)? = nil) -> Result<Void, HelperError> {
        session.queue.sync {
            var first = true
            for step in steps {
                switch step {
                case .wait(let ms):
                    if ms > 0 { usleep(useconds_t(ms * 1_000)) }
                case .send(let event):
                    if let broken = session.transport.brokenReason {
                        return .failure(HelperError(.failed, "\(broken) while sending to \(session.udid)"))
                    }
                    session.transport.send(event)
                    if first {
                        first = false
                        onFirstSend?()
                    }
                }
            }
            return .success(())
        }
    }
}
