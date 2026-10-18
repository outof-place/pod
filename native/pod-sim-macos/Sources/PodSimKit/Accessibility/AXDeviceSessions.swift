import CoreGraphics
import Foundation
import XPC

/// A tree as one walk read it, before hit tests and normalization: what the cache keeps.
struct AXTreeRead: @unchecked Sendable {
    var elements: [AXRawElement]
    /// Each element's parent index; -1 for the application element.
    var parents: [Int]
    var objectIDs: [UInt64?]
    var pids: [Int32?]
    var appPid: Int32?
}

/// What must hold for a kept tree to still be the screen's: no accessibility notification and no
/// input through this helper since it was read, and the framebuffer still the same surface at the
/// same seed (nothing drew). Taken before the walk, so a change during the walk ends it.
struct AXScreenStamp: Equatable, Sendable {
    let changes: UInt64
    let surface: UInt32
    let seed: UInt32
}

/// The last tree read and the stamp it was read under, with the hit answers learned for it since.
/// Nothing is kept without a stamp: no framebuffer to read, or no notifications heard.
struct AXTreeCache {
    private(set) var changes: UInt64 = 0
    private(set) var listening = false
    private var kept: (tree: AXTreeRead, stamp: AXScreenStamp, hits: [Int: Bool?])?

    mutating func changed() { changes &+= 1 }

    mutating func listen() { listening = true }

    /// Notifications stopped: nothing proves a kept tree current any more.
    mutating func deaf() {
        changes &+= 1
        listening = false
        kept = nil
    }

    func stamp(surface: (id: UInt32, seed: UInt32)?) -> AXScreenStamp? {
        guard let surface, listening else { return nil }
        return AXScreenStamp(changes: changes, surface: surface.id, seed: surface.seed)
    }

    /// The kept tree while `now` (taken just before) matches its stamp. A reboot never gets here: it
    /// makes a new session (AXDeviceSessions, by `lastBootedAt`).
    func cached(at now: AXScreenStamp?) -> (tree: AXTreeRead, hits: [Int: Bool?])? {
        guard let now, listening, let kept, kept.stamp == now else { return nil }
        return (kept.tree, kept.hits)
    }

    /// A read without a stamp proves nothing and leaves the kept tree, which its own stamp still checks.
    mutating func keep(_ tree: AXTreeRead, stamp: AXScreenStamp?) {
        guard let stamp, listening else { return }
        kept = (tree, stamp, [:])
    }

    /// Hit answers for the kept tree read under `stamp`, if it is still that one.
    mutating func addHits(_ hits: [Int: Bool?], stamp: AXScreenStamp?) {
        guard let stamp, var current = kept, current.stamp == stamp else { return }
        current.hits.merge(hits) { _, new in new }
        kept = current
    }
}

/// Where a session's connections come from: a device's bridge endpoint (tests give their own).
protocol AXBridgeConnector: Sendable {
    func connect(queue: DispatchQueue, onEvent: @escaping @Sendable (xpc_object_t) -> Void) -> AXBridgeLane?
}

extension AXBridgeEndpoint: AXBridgeConnector {}

/// Where a device's kept tree lives (AXDeviceSession; tests give their own).
protocol AXTreeKeeper: AnyObject {
    func stamp(surface: (id: UInt32, seed: UInt32)?) -> AXScreenStamp?
    func cached(at now: AXScreenStamp?) -> (tree: AXTreeRead, hits: [Int: Bool?])?
    func keep(_ tree: AXTreeRead, stamp: AXScreenStamp?)
}

/// A device's accessibility session in this helper, for one boot: the bridge endpoint, one connection
/// that stays open only to hear the device's notifications, and the tree cache. Nothing polls: the
/// cache's counter moves when a notification or an input arrives, and the session ends after its idle
/// time (AXDeviceSessions), closing the connection.
final class AXDeviceSession: AXTreeKeeper, @unchecked Sendable {
    let udid: String
    let device: NSObject
    /// The device's `lastBootedAt` when the session began: the same SimDevice object outlives a reboot.
    let boot: Date?
    let endpoint: AXBridgeConnector
    // A condition so the self-test can wait for the listening connection's first answer.
    private let lock = NSCondition()
    private var listener: (lane: AXBridgeLane, generation: Int)?
    private var generations = 0
    private var asking = false
    private var closed = false
    private var cache = AXTreeCache()
    private var problem: String?
    private var toldProblem = false
    private let log: @Sendable (String) -> Void
    private var nextListen = DispatchTime(uptimeNanoseconds: 0)
    fileprivate var lastUse = DispatchTime.now()
    private let events = DispatchQueue(label: "pod-sim.ax.notifications", qos: .utility)
    /// A service that did not answer is asked again at most this often, not on every snapshot.
    private let listenRetrySeconds: Double

    init(
        udid: String, device: NSObject, boot: Date?, endpoint: AXBridgeConnector, listenRetrySeconds: Double = 10,
        log: @escaping @Sendable (String) -> Void = HelperLog.note
    ) {
        self.udid = udid
        self.device = device
        self.boot = boot
        self.endpoint = endpoint
        self.listenRetrySeconds = listenRetrySeconds
        self.log = log
    }

    /// Why the session does not hear notifications (so keeps no tree); nil while it does.
    var listenProblem: String? { lock.withLock { cache.listening ? nil : (problem ?? "not listening") } }
    var isListening: Bool { lock.withLock { cache.listening } }

    /// `listenProblem` once the listening connection's first request has been answered, or `timeout` passed.
    func listenProblem(within timeout: TimeInterval) -> String? {
        let end = Date().addingTimeInterval(timeout)
        return lock.withLock {
            while asking, lock.wait(until: end) {}
            if cache.listening { return nil }
            return problem ?? (asking ? "the notification connection did not answer within \(timeout) s" : "not listening")
        }
    }

    /// Under the lock: why the session does not listen; what to log the first time in this session.
    private func failed(_ reason: String) -> String? {
        problem = reason
        guard !toldProblem else { return nil }
        toldProblem = true
        return "ax \(udid): no accessibility notifications (\(reason)), so no tree is kept; asked again at most every \(Int(listenRetrySeconds)) s"
    }

    /// Opens the listening connection unless it is open or being opened, without waiting: the
    /// service sends notifications only to a connection that has asked something, so it asks for the
    /// frontmost application once, and the session listens from that answer on. Reads before it
    /// are not kept.
    func listen(vocabulary: AXBridgeRequests.Vocabulary, timeout: TimeInterval) {
        let generation = lock.withLock { () -> Int? in
            guard !closed, !cache.listening, !asking, DispatchTime.now() >= nextListen else { return nil }
            nextListen = .now() + listenRetrySeconds
            asking = true
            generations += 1
            return generations
        }
        guard let generation else { return }
        guard let lane = endpoint.connect(queue: events, onEvent: { [weak self] event in self?.heard(event, on: generation) }) else {
            let told = lock.withLock { () -> String? in
                asking = false
                lock.broadcast()
                return failed("no connection to \(AXBridgeTransport.service)")
            }
            if let told { log(told) }
            return
        }
        AXBridgeReadLane(lane, vocabulary: vocabulary, timeout: timeout).frontmost { [weak self] app in
            guard let self else { return lane.cancel() }
            let (unused, told) = self.lock.withLock { () -> ([AXBridgeLane], String?) in
                asking = false
                lock.broadcast()
                guard app != nil, !closed else {
                    return ([lane], closed ? nil : failed("the notification connection's first request went unanswered"))
                }
                defer {
                    listener = (lane, generation)
                    cache.listen()
                    problem = nil
                }
                return (listener.map { [$0.lane] } ?? [], nil)
            }
            unused.forEach { $0.cancel() }
            if let told { self.log(told) }
        }
    }

    /// Any message that is not a reply is a notification (layout, screen, value, focus...); which
    /// one does not matter, since a notification's element is where VoiceOver should go next, not
    /// what changed. Only the current listening connection's end makes the session deaf.
    func heard(_ event: xpc_object_t, on generation: Int) {
        let told = lock.withLock { () -> String? in
            guard xpc_get_type(event) == XPC_TYPE_ERROR else {
                cache.changed()
                return nil
            }
            guard listener?.generation == generation else { return nil }
            listener = nil
            cache.deaf()
            return failed("the notification connection ended")
        }
        if let told { log(told) }
    }

    /// Input sent through this helper: the screen is about to change.
    func inputArrived() { lock.withLock { cache.changed() } }

    func stamp(surface: (id: UInt32, seed: UInt32)?) -> AXScreenStamp? { lock.withLock { cache.stamp(surface: surface) } }

    func cached(at now: AXScreenStamp?) -> (tree: AXTreeRead, hits: [Int: Bool?])? { lock.withLock { cache.cached(at: now) } }

    func keep(_ tree: AXTreeRead, stamp: AXScreenStamp?) { lock.withLock { cache.keep(tree, stamp: stamp) } }

    func addHits(_ hits: [Int: Bool?], stamp: AXScreenStamp?) { lock.withLock { cache.addHits(hits, stamp: stamp) } }

    fileprivate func close() {
        let lane = lock.withLock { () -> AXBridgeLane? in
            defer {
                closed = true
                listener = nil
                cache.deaf()
            }
            return listener?.lane
        }
        lane?.cancel()
    }
}

/// Every device's session, made on its first snapshot and closed after `idleSeconds` without one.
final class AXDeviceSessions: @unchecked Sendable {
    /// Agents read the screen every few seconds while they drive a device and pause for a minute or
    /// two while they think; past two minutes the next snapshot reconnects (a lookup and one request).
    static let idleSeconds: Double = 120
    static let shared = AXDeviceSessions(idleSeconds: idleSeconds)

    private let idleSeconds: Double
    private let lock = NSLock()
    private var sessions: [String: AXDeviceSession] = [:]
    private let timers = DispatchQueue(label: "pod-sim.ax.sessions", qos: .utility)
    private var timer: DispatchSourceTimer?

    init(idleSeconds: Double) {
        self.idleSeconds = idleSeconds
    }

    /// This boot's session, made (looking the service up, starting to listen) when there is none; a
    /// session of an earlier boot is closed first, and one whose listening connection ended asks
    /// again (at most every `listenRetrySeconds`).
    func session(
        for device: SimDeviceHandle, vocabulary: AXBridgeRequests.Vocabulary, timeout: TimeInterval
    ) -> Result<AXDeviceSession, HelperError> {
        session(udid: device.udid, device: device.object, boot: device.lastBootedAt, lookup: { AXBridgeEndpoint.lookup(device).map { $0 } }) {
            $0.listen(vocabulary: vocabulary, timeout: timeout)
        }
    }

    func session(
        udid: String, device: NSObject, boot: Date?, lookup: () -> Result<AXBridgeConnector, HelperError>, listen: (AXDeviceSession) -> Void
    ) -> Result<AXDeviceSession, HelperError> {
        if let kept = lock.withLock({ () -> AXDeviceSession? in
            guard let kept = sessions[udid], kept.device === device, kept.boot == boot else { return nil }
            kept.lastUse = .now()
            return kept
        }) {
            listen(kept)
            return .success(kept)
        }
        return lookup().map { endpoint in
            let made = AXDeviceSession(udid: udid, device: device, boot: boot, endpoint: endpoint)
            listen(made)
            let replaced = lock.withLock { () -> AXDeviceSession? in
                defer { sessions[udid] = made }
                return sessions[udid]
            }
            replaced?.close()
            armTimer()
            return made
        }
    }

    /// Closes a device's session whose endpoint stopped answering: the next snapshot looks it up again.
    func discard(_ session: AXDeviceSession) {
        let removed = lock.withLock { () -> Bool in
            guard sessions[session.udid] === session else { return false }
            sessions[session.udid] = nil
            return true
        }
        if removed { session.close() }
    }

    func existing(_ udid: String) -> AXDeviceSession? {
        lock.withLock { sessions[udid] }
    }

    func inputArrived(_ udid: String) {
        existing(udid)?.inputArrived()
    }

    var count: Int { lock.withLock { sessions.count } }

    /// One timer for all sessions, set for the earliest end; it fires only when a session may be due.
    private func armTimer() {
        lock.withLock {
            if timer == nil {
                let made = DispatchSource.makeTimerSource(queue: timers)
                made.setEventHandler { [weak self] in self?.closeIdle() }
                made.activate()
                timer = made
            }
            reschedule()
        }
    }

    /// Under the lock.
    private func reschedule() {
        guard let earliest = sessions.values.map(\.lastUse).min() else {
            timer?.schedule(deadline: .distantFuture)
            return
        }
        timer?.schedule(deadline: earliest + idleSeconds)
    }

    func closeIdle(now: DispatchTime = .now()) {
        let idle = lock.withLock { () -> [AXDeviceSession] in
            let due = sessions.values.filter { now.uptimeNanoseconds >= ($0.lastUse + idleSeconds).uptimeNanoseconds }
            for session in due { sessions[session.udid] = nil }
            reschedule()
            return due
        }
        for session in idle {
            session.close()
            AXTransports.shared.discard(session.udid)
            HelperLog.note("ax \(session.udid): no snapshot for \(Int(idleSeconds)) s; its accessibility session is closed")
        }
    }
}
