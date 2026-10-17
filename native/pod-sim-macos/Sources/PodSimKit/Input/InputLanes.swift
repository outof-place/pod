import Foundation

/// A device lane given up on: its running call is stuck in a private call past its deadline.
struct LaneWedge: Equatable, Sendable {
    let udid: String
    /// How long the stuck call has been running.
    let stuckMs: Int
    /// Calls that were waiting behind it, answered `wedged` and never sent.
    let dropped: Int
    /// Lanes given up on since the helper started: each keeps one thread stuck in the call.
    let abandoned: Int
}

/// `hid` calls of one device run one at a time in the order they arrived (the stdin reader hands
/// them over in that order), each whole: connecting, the pasteboard, the events and the barrier.
/// Devices never wait on each other. A lane holding `maxDepth` calls answers the next `busy` at once.
///
/// A call still running `wedgeGraceMs` past its deadline is stuck in a private call that may never
/// return (a thread cannot be cancelled). The next call for that device finds the lane wedged: the
/// lane is abandoned with its stuck thread, the calls waiting behind it are answered `wedged` (never
/// sent), `onWedge` drops the device's input connection, and the call runs on a fresh lane. Other
/// devices never notice. Abandoned threads add up, so past a few of them the helper asks the runtime
/// to replace it (HelperMethods.inputWedged).
final class InputLanes: @unchecked Sendable {
    /// Stage 8 streams touches at pointer rate (60 to 120 a second), each answered in a few ms by a
    /// healthy device: 16 is about 130 ms of 120 Hz input. Past it the device is not keeping up, and
    /// queueing more only delivers stale moves later; the caller should coalesce them instead.
    static let maxDepth = 16
    static let wedgeGraceMs = 2_000

    /// Mutable fields are read and written under InputLanes's lock only.
    private final class Lane: @unchecked Sendable {
        let queue: DispatchQueue
        /// Calls accepted and not finished: the running one and those waiting.
        var depth = 0
        /// The running call's start and deadline, CLOCK_UPTIME_RAW nanoseconds.
        var running: (startedNs: UInt64, deadlineNs: UInt64)?
        /// Calls waiting behind the running one, to answer if the lane is given up on.
        var waiting: [ObjectIdentifier: DeadlineCall] = [:]
        var abandoned = false

        init(udid: String) {
            queue = DispatchQueue(label: "pod-sim.input.\(udid)", qos: .userInteractive)
        }
    }

    private let maxDepth: Int
    private let wedgeGraceNs: UInt64
    private let lock = NSLock()
    private var lanes: [String: Lane] = [:]
    private var abandonedCount = 0
    /// Told once per abandoned lane, outside the lock.
    var onWedge: (@Sendable (LaneWedge) -> Void)?

    init(maxDepth: Int = InputLanes.maxDepth, wedgeGraceMs: Int = InputLanes.wedgeGraceMs) {
        self.maxDepth = maxDepth
        self.wedgeGraceNs = UInt64(wedgeGraceMs) * 1_000_000
    }

    /// Queues `body` on the device's lane. A call whose deadline answered `timeout` while it waited
    /// is never run, so nothing reaches the device after the caller was told it timed out unsent.
    func submit(udid: String, call: DeadlineCall, _ body: @escaping @Sendable () -> Reply) {
        let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        var wedge: (LaneWedge, [DeadlineCall])?
        // A lane stays once made (one queue per device the helper has seen): making a queue per call
        // after an idle moment cost more than the lane's whole hop.
        let lane = lock.withLock { () -> Lane? in
            var lane = lanes[udid] ?? Lane(udid: udid)
            if let running = lane.running, now > running.deadlineNs + wedgeGraceNs {
                lane.abandoned = true
                abandonedCount += 1
                let stranded = Array(lane.waiting.values)
                wedge = (LaneWedge(udid: udid, stuckMs: Int((now - running.startedNs) / 1_000_000), dropped: stranded.count, abandoned: abandonedCount), stranded)
                lane = Lane(udid: udid)
            }
            lanes[udid] = lane
            guard lane.depth < maxDepth else { return nil }
            lane.depth += 1
            lane.waiting[ObjectIdentifier(call)] = call
            return lane
        }
        if let (report, stranded) = wedge {
            HelperLog.note("hid lane of \(udid) wedged: a call has been stuck \(report.stuckMs) ms in a private call; \(stranded.count) waiting calls dropped, the device's input connection reset")
            for waiting in stranded {
                waiting.finish(.error(HelperError(.wedged, "hid: the device's input was stuck in a private call; this call was not sent, send it again")))
            }
            onWedge?(report)
        }
        guard let lane else {
            call.finish(.error(HelperError(
                .busy, "hid: \(maxDepth) calls for \(udid) are already running or waiting; the device is not keeping up, so wait for their answers")))
            return
        }
        lane.queue.async {
            let runs = self.lock.withLock { () -> Bool in
                lane.waiting[ObjectIdentifier(call)] = nil
                guard !lane.abandoned, !call.answered else { return false }
                lane.running = (clock_gettime_nsec_np(CLOCK_UPTIME_RAW), call.deadlineNs)
                return true
            }
            let outcome = runs ? body() : nil
            // The slot frees before the answer goes out, so a caller that waits for answers is never busy.
            self.lock.withLock {
                lane.running = nil
                lane.depth -= 1
            }
            outcome.map(call.finish)
        }
    }
}
