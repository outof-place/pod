import Foundation

/// `hid` calls of one device run one at a time in the order they arrived (the stdin reader hands
/// them over in that order), each whole: connecting, the pasteboard, the events and the barrier.
/// Devices never wait on each other. A lane holding `maxDepth` calls answers the next `busy` at once.
final class InputLanes: @unchecked Sendable {
    /// Stage 8 streams touches at pointer rate (60 to 120 a second), each answered in a few ms by a
    /// healthy device: 16 is about 130 ms of 120 Hz input. Past it the device is not keeping up, and
    /// queueing more only delivers stale moves later; the caller should coalesce them instead.
    static let maxDepth = 16

    /// `depth` is read and written under InputLanes's lock only.
    private final class Lane: @unchecked Sendable {
        let queue: DispatchQueue
        /// Calls accepted and not finished: the running one and those waiting.
        var depth = 0

        init(udid: String) {
            queue = DispatchQueue(label: "pod-sim.input.\(udid)", qos: .userInteractive)
        }
    }

    private let maxDepth: Int
    private let lock = NSLock()
    private var lanes: [String: Lane] = [:]

    init(maxDepth: Int = InputLanes.maxDepth) {
        self.maxDepth = maxDepth
    }

    /// Queues `body` on the device's lane. A call whose deadline answered `timeout` while it waited
    /// is never run, so nothing reaches the device after the caller was told it timed out unsent.
    func submit(udid: String, call: DeadlineCall, _ body: @escaping @Sendable () -> Reply) {
        // A lane stays once made (one queue per device the helper has seen): making a queue per call
        // after an idle moment cost more than the lane's whole hop.
        let lane = lock.withLock { () -> Lane? in
            let lane = lanes[udid] ?? Lane(udid: udid)
            lanes[udid] = lane
            guard lane.depth < maxDepth else { return nil }
            lane.depth += 1
            return lane
        }
        guard let lane else {
            call.finish(.error(HelperError(
                .busy, "hid: \(maxDepth) calls for \(udid) are already running or waiting; the device is not keeping up, so wait for their answers")))
            return
        }
        lane.queue.async {
            let outcome = call.answered ? nil : body()
            // The slot frees before the answer goes out, so a caller that waits for answers is never busy.
            self.lock.withLock { lane.depth -= 1 }
            outcome.map(call.finish)
        }
    }
}
