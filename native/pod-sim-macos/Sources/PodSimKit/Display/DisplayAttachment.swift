import Foundation
import IOSurface

public struct CallbackMicros: Codable, Equatable, Sendable {
    public let n: Int
    public let p50: Double
    public let p95: Double
    public let max: Double
}

public struct DisplayStats: Codable, Equatable, Sendable {
    public let udid: String
    public let seconds: Double
    /// One per presented frame (`frameCallback`); 0 while the screen is static.
    public let frameCallbacks: Int
    /// Surface (re)mounts, and once at registration when a surface exists.
    public let surfaceCallbacks: Int
    /// Frames whose IOSurface seed changed: what a viewer would redraw.
    public let seedChanges: Int
    /// Time spent inside the frame callback over the last 512 frames: the helper's own cost per frame.
    public var callbackMicros: CallbackMicros? = nil
    /// The viewers this display streams to; a stream whose viewer is gone is no longer one.
    public var streams: [StreamStats]? = nil
}

/// Told about every frame whose seed changed, on the attachment's queue: settle's damage watch. Must
/// return at once (CoreSimulator waits for the frame callback).
protocol FrameObserver: AnyObject {
    func frameArrived()
}

/// Screen callbacks registered on one device's main display, and the viewers its frames go to.
/// Everything mutable lives on `queue`, the callbacks' own serial queue: CoreSimulator delivers them
/// synchronously and waits for each, so a callback counts, sends one small Mach message per viewer
/// and signals observers, nothing more. A stream that ends without a `stopStream` (its viewer is
/// gone, the attachment stops) is reported to `onStreamEnded`, which must return at once.
final class DisplayAttachment: @unchecked Sendable {
    let port: DisplayPort
    /// Pixels per point.
    let scale: Double
    /// The device's `lastBootedAt` when attached; another value later means it rebooted since.
    let bootedAt: Date?
    let attachedAtNs: UInt64
    private let token = UUID()
    private let queue: DispatchQueue
    private let scaleX100: UInt32
    private var frameCallbacks = 0
    private var surfaceCallbacks = 0
    private var seedChanges = 0
    private var surface: IOSurfaceRef?
    private var lastSeed: UInt32 = 0
    private var lastFrameNs: UInt64?
    private var streams: [UInt32: FrameStream] = [:]
    private var observers: [ObjectIdentifier: FrameObserver] = [:]
    /// Held by an `attachDisplay`; streams and settles hold it too (see `isHeld`).
    private var explicitHold = false
    private var callbackNanos = [UInt32](repeating: 0, count: 512)
    private var callbackCount = 0
    private let onStreamEnded: @Sendable (StreamEndedEvent) -> Void

    init(
        port: DisplayPort, scale: Double = 1, bootedAt: Date? = nil,
        onStreamEnded: @escaping @Sendable (StreamEndedEvent) -> Void = { _ in }
    ) {
        self.port = port
        self.onStreamEnded = onStreamEnded
        self.scale = scale > 0 ? scale : 1
        self.bootedAt = bootedAt
        self.scaleX100 = UInt32((self.scale * 100).rounded())
        self.attachedAtNs = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        self.queue = DispatchQueue(label: "pod-sim.display.\(port.udid)", qos: .userInteractive)
    }

    func start() -> Result<Void, HelperError> {
        queue.sync { surface = port.surface() }
        return port.registerCallbacks(
            token: token, queue: queue,
            onFrame: { [weak self] in self?.frame() },
            onSurface: { [weak self] surface in self?.surfaceChanged(surface) })
    }

    var currentSurface: IOSurfaceRef? { queue.sync { surface } }

    /// Why this attachment no longer shows the device's framebuffer as a fresh lookup finds it; nil
    /// while it does. Every lookup hands out a new descriptor proxy, so the surface is the identity:
    /// within a boot both answer the same IOSurface; after a reboot the old proxy answers none
    /// (both seen on CoreSimulator 1171.7, stage 2a fix).
    func staleness(against fresh: DisplayPort) -> String? {
        guard let mine = port.surface() else { return "its surface no longer answers" }
        guard let theirs = fresh.surface() else { return "this boot's display has no surface" }
        let (old, new) = (IOSurfaceGetID(mine), IOSurfaceGetID(theirs))
        return old == new ? nil : "it shows surface \(old), this boot's is \(new)"
    }

    func stats() -> DisplayStats { queue.sync { snapshot() } }

    /// Unregisters, then drains callbacks already queued so the final counts are complete; every
    /// stream ends with it, reported with `reason` (nil: the helper is exiting, nobody to tell).
    func stop(_ reason: StreamEndReason?) -> DisplayStats {
        port.unregisterCallbacks(token: token)
        let (final, ended) = queue.sync {
            let final = snapshot()
            let ended = Array(streams.values)
            streams.removeAll()
            observers.removeAll()
            return (final, ended)
        }
        if let reason {
            for stream in ended.sorted(by: { $0.token < $1.token }) { onStreamEnded(event(stream, reason)) }
        }
        return final
    }

    // MARK: - holds

    var isHeld: Bool { queue.sync { explicitHold || !streams.isEmpty || !observers.isEmpty } }

    func hold() { queue.sync { explicitHold = true } }

    /// When the last frame changed the surface (uptime ns), nil when none has since attach.
    var lastFrameAtNs: UInt64? { queue.sync { lastFrameNs } }

    // MARK: - streams

    /// Starts sending frames to `stream`'s viewer, replacing a stream with the same token, and hands
    /// it the surface now. The surface, or nil when the display has none yet.
    func addStream(_ stream: FrameStream) -> IOSurfaceRef? {
        queue.sync {
            streams[stream.token] = stream
            if let surface { handle(stream, stream.sendSurface(surface, scaleX100: scaleX100), attempt: 0) }
            return surface
        }
    }

    /// The stream under `token`, only while its nonce is `nonce` when one is given.
    func removeStream(token: UInt32, nonce: UInt64? = nil) -> StreamStats? {
        queue.sync {
            guard let stream = streams[token], nonce.map({ $0 == stream.nonce }) ?? true else { return nil }
            streams[token] = nil
            return stream.stats()
        }
    }

    func hasStream(token: UInt32) -> Bool { queue.sync { streams[token] != nil } }

    /// Takes over a replaced attachment's viewers and its `attachDisplay` hold (the device rebooted):
    /// the viewers get this boot's surface now.
    func adopt(from old: DisplayAttachment) {
        let (moved, held) = old.handOver()
        queue.sync {
            explicitHold = explicitHold || held
            for stream in moved {
                stream.forgetSurface()
                streams[stream.token] = stream
                if let surface { handle(stream, stream.sendSurface(surface, scaleX100: scaleX100), attempt: 0) }
            }
        }
    }

    private func handOver() -> ([FrameStream], Bool) {
        queue.sync {
            let taken = Array(streams.values)
            streams.removeAll()
            return (taken, explicitHold)
        }
    }

    // MARK: - observers

    func addObserver(_ observer: FrameObserver) { queue.sync { observers[ObjectIdentifier(observer)] = observer } }

    func removeObserver(_ observer: FrameObserver) { queue.sync { _ = observers.removeValue(forKey: ObjectIdentifier(observer)) } }

    // MARK: - callbacks

    private func frame() {
        let entered = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        frameCallbacks += 1
        if let surface {
            let seed = IOSurfaceGetSeed(surface)
            if seed != lastSeed {
                seedChanges += 1
                lastSeed = seed
                lastFrameNs = entered
                for stream in streams.values {
                    handle(stream, stream.sendFrame(surface: surface, seed: seed, scaleX100: scaleX100, advance: true), attempt: 0)
                }
                for observer in observers.values { observer.frameArrived() }
            }
        }
        callbackNanos[callbackCount % callbackNanos.count] = UInt32(clamping: clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - entered)
        callbackCount += 1
    }

    private func surfaceChanged(_ new: IOSurfaceRef?) {
        surfaceCallbacks += 1
        guard let new else { return }
        let changed = surface.map { IOSurfaceGetID($0) != IOSurfaceGetID(new) } ?? true
        surface = new
        guard changed else { return }
        for stream in streams.values { handle(stream, stream.sendSurface(new, scaleX100: scaleX100), attempt: 0) }
        for observer in observers.values { observer.frameArrived() }
    }

    /// On `queue`: a full viewer is retried later; one that is gone leaves the display at once.
    private func handle(_ stream: FrameStream, _ delivery: FrameStream.Delivery, attempt: Int) {
        switch delivery {
        case .sent: return
        case .full: scheduleRetry(stream, attempt: attempt)
        case .ended:
            guard streams[stream.token] === stream else { return }
            streams[stream.token] = nil
            onStreamEnded(event(stream, .viewerGone))
        }
    }

    private func event(_ stream: FrameStream, _ reason: StreamEndReason) -> StreamEndedEvent {
        StreamEndedEvent(udid: port.udid, token: stream.token, nonce: FrameStream.nonceText(stream.nonce), reason: reason)
    }

    /// One retry in flight per stream; it sends whatever frame is newest when it fires.
    private func scheduleRetry(_ stream: FrameStream, attempt: Int) {
        guard stream.retryAttempt == nil, attempt < FrameStream.retryDelaysMs.count else { return }
        stream.retryAttempt = attempt
        queue.asyncAfter(deadline: .now() + .milliseconds(FrameStream.retryDelaysMs[attempt])) { [weak self, weak stream] in
            guard let self, let stream else { return }
            stream.retryAttempt = nil
            guard self.streams[stream.token] === stream, let surface = self.surface, stream.ended == nil else { return }
            let delivery = stream.seq == 0
                ? stream.sendSurface(surface, scaleX100: self.scaleX100)
                : stream.sendFrame(surface: surface, seed: IOSurfaceGetSeed(surface), scaleX100: self.scaleX100, advance: false)
            self.handle(stream, delivery, attempt: attempt + 1)
        }
    }

    private func snapshot() -> DisplayStats {
        let seconds = Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - attachedAtNs) / 1e9
        var stats = DisplayStats(
            udid: port.udid, seconds: (seconds * 100).rounded() / 100,
            frameCallbacks: frameCallbacks, surfaceCallbacks: surfaceCallbacks, seedChanges: seedChanges)
        let n = min(callbackCount, callbackNanos.count)
        if n > 0 {
            let sorted = callbackNanos.prefix(n).sorted()
            let micros = { (rank: Double) -> Double in
                (Double(sorted[max(0, Int((rank * Double(n)).rounded(.up)) - 1)]) / 100).rounded() / 10
            }
            stats.callbackMicros = CallbackMicros(n: n, p50: micros(0.5), p95: micros(0.95), max: (Double(sorted[n - 1]) / 100).rounded() / 10)
        }
        if !streams.isEmpty { stats.streams = streams.values.map { $0.stats() }.sorted { $0.token < $1.token } }
        return stats
    }
}

/// What the registry keeps per device: `DisplayAttachment` in the helper, a stand-in in tests.
protocol RegisteredDisplay: AnyObject, Sendable {
    func start() -> Result<Void, HelperError>
    func stats() -> DisplayStats
    /// Ends the display and its streams, which are reported with `reason` unless it is nil.
    func stop(_ reason: StreamEndReason?) -> DisplayStats
}

extension DisplayAttachment: RegisteredDisplay {}

/// At most one attachment per device. Remote calls (`start`, a freshness check, `stop`) run outside
/// the lock: a device that is slow to attach marks only its own slot, so stats and detach of every
/// other device go on.
final class DisplayRegistry<Display: RegisteredDisplay>: @unchecked Sendable {
    private enum Slot {
        case attached(Display)
        /// An attach is running; `previous` (one being checked or replaced) still answers stats.
        case attaching(DispatchGroup, previous: Display?)
    }

    private enum DetachStep {
        case none, stop(Display), wait(DispatchGroup)
    }

    private let lock = NSLock()
    private var slots: [String: Slot] = [:]
    // Stale proxies can be slow to refuse; their callbacks are removed off the caller's thread.
    private let retired = DispatchQueue(label: "pod-sim.display.retired", qos: .utility, attributes: .concurrent)

    func attachment(_ udid: String) -> Display? {
        lock.withLock {
            switch slots[udid] {
            case .attached(let display): display
            case .attaching(_, let previous): previous
            case nil: nil
            }
        }
    }

    /// Keeps the existing attachment while `isCurrent` says it still shows this boot's framebuffer
    /// (`alreadyAttached`); otherwise starts `make()` in its place, after `replacing` saw both. A
    /// second attach of the same device waits for the first, up to `waitLimit`.
    func attach(
        _ udid: String, waitLimit: DispatchTimeInterval = .seconds(5),
        isCurrent: (Display) -> Bool, make: () -> Display, replacing: (_ old: Display, _ new: Display) -> Void = { _, _ in }
    ) -> Result<(Display, alreadyAttached: Bool), HelperError> {
        let deadline = DispatchTime.now() + waitLimit
        let mine = DispatchGroup()
        var existing: Display?
        while true {
            let busy = lock.withLock { () -> DispatchGroup? in
                switch slots[udid] {
                case .attaching(let other, _):
                    return other
                case .attached(let display):
                    existing = display
                case nil:
                    existing = nil
                }
                mine.enter()
                slots[udid] = .attaching(mine, previous: existing)
                return nil
            }
            guard let busy else { break }
            if busy.wait(timeout: deadline) == .timedOut {
                return .failure(HelperError(.timeout, "another attach of \(udid) is still running"))
            }
        }
        defer { mine.leave() }
        if let existing, isCurrent(existing) {
            lock.withLock { slots[udid] = .attached(existing) }
            return .success((existing, true))
        }
        let display = make()
        let started = display.start()
        if case .success = started, let existing { replacing(existing, display) }
        lock.withLock {
            if case .success = started { slots[udid] = .attached(display) } else { slots[udid] = nil }
        }
        // Its streams moved to the new attachment; when that did not start, they end here.
        if let existing { retire(existing, .deviceRebooted) }
        return started.map { (display, false) }
    }

    /// Final counts; waits out an attach of the same device in progress, up to `waitLimit`. Streams
    /// still on the display end with `reason`.
    func detach(
        _ udid: String, reason: StreamEndReason? = .detached, waitLimit: DispatchTimeInterval = .seconds(5)
    ) -> Result<DisplayStats, HelperError> {
        let deadline = DispatchTime.now() + waitLimit
        while true {
            let step = lock.withLock { () -> DetachStep in
                switch slots[udid] {
                case .attaching(let group, _): return .wait(group)
                case .attached(let display):
                    slots[udid] = nil
                    return .stop(display)
                case nil: return .none
                }
            }
            switch step {
            case .none: return .failure(HelperError(.notAttached, "no display attached for \(udid)"))
            case .stop(let display): return .success(display.stop(reason))
            case .wait(let group):
                if group.wait(timeout: deadline) == .timedOut {
                    return .failure(HelperError(.timeout, "an attach of \(udid) is still running"))
                }
            }
        }
    }

    /// Removes the attachments `shouldDrop` names (devices no longer booted); checked outside the lock.
    func drop(where shouldDrop: (String) -> Bool, reason: StreamEndReason) {
        let attached = lock.withLock {
            slots.compactMap { entry -> (String, Display)? in
                if case .attached(let display) = entry.value { (entry.key, display) } else { nil }
            }
        }
        for (udid, display) in attached where shouldDrop(udid) { drop(udid, display, reason: reason) }
    }

    /// Removes `display` if it is still `udid`'s attachment.
    func drop(_ udid: String, _ display: Display, reason: StreamEndReason) {
        let removed = lock.withLock { () -> Bool in
            guard case .attached(let current) = slots[udid], current === display else { return false }
            slots[udid] = nil
            return true
        }
        if removed { retire(display, reason) }
    }

    /// The helper is exiting: nobody is left to tell about the streams.
    func detachAll() {
        for udid in lock.withLock({ Array(slots.keys) }) { _ = detach(udid, reason: nil, waitLimit: .seconds(2)) }
    }

    private func retire(_ display: Display, _ reason: StreamEndReason) {
        retired.async { _ = display.stop(reason) }
    }
}
