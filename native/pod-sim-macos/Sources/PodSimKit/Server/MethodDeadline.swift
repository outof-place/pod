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
        let call = start(method, deadlineMs: deadlineMs, reply: reply)
        work.async { call.finish(body()) }
    }

    /// Starts the deadline clock now, for a caller that runs the work on its own queue.
    func start(_ method: String, deadlineMs: Int, reply: @escaping @Sendable (Reply) -> Void) -> DeadlineCall {
        let call = DeadlineCall(reply)
        timers.asyncAfter(deadline: .now() + .milliseconds(deadlineMs)) {
            call.finish(.error(HelperError(.timeout, "\(method) passed its \(deadlineMs) ms deadline in the helper")))
        }
        return call
    }
}

/// One call's answer: the first one goes out, a later one is dropped.
final class DeadlineCall: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: (@Sendable (Reply) -> Void)?

    init(_ reply: @escaping @Sendable (Reply) -> Void) {
        self.reply = reply
    }

    /// True once an answer went out (the work's, or the deadline's `timeout`).
    var answered: Bool { lock.withLock { reply == nil } }

    func finish(_ outcome: Reply) {
        let first = lock.withLock { () -> (@Sendable (Reply) -> Void)? in
            defer { reply = nil }
            return reply
        }
        first?(outcome)
    }
}
