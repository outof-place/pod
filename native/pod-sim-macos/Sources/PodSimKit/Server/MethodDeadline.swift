import Foundation

/// Runs each method on a concurrent queue and answers `timeout` itself when the method's deadline
/// passes first; the late result is dropped. A private call that never returns keeps its thread,
/// and the runtime recycles a helper that stops answering altogether (README, Protocol v1).
final class DeadlineDispatcher: @unchecked Sendable {
    private let work: DispatchQueue
    private let timers = DispatchQueue(label: "pod-sim.deadlines", qos: .userInitiated)

    init(work: DispatchQueue = DispatchQueue(label: "pod-sim.work", qos: .userInitiated, attributes: .concurrent)) {
        self.work = work
    }

    func run(_ method: String, deadlineMs: Int, _ body: @escaping @Sendable () -> Reply, reply: @escaping @Sendable (Reply) -> Void) {
        let once = OnceReply(reply)
        timers.asyncAfter(deadline: .now() + .milliseconds(deadlineMs)) {
            once.send(.error(HelperError(.timeout, "\(method) passed its \(deadlineMs) ms deadline in the helper")))
        }
        work.async { once.send(body()) }
    }
}

/// The first answer goes out; a later one is dropped.
private final class OnceReply: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: (@Sendable (Reply) -> Void)?

    init(_ reply: @escaping @Sendable (Reply) -> Void) {
        self.reply = reply
    }

    func send(_ outcome: Reply) {
        let first = lock.withLock { () -> (@Sendable (Reply) -> Void)? in
            defer { reply = nil }
            return reply
        }
        first?(outcome)
    }
}
