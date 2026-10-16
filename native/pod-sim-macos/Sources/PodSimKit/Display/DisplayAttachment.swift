import Foundation
import IOSurface

public struct DisplayStats: Codable, Equatable, Sendable {
    public let udid: String
    public let seconds: Double
    /// One per presented frame (`frameCallback`); 0 while the screen is static.
    public let frameCallbacks: Int
    /// Surface (re)mounts, and once at registration when a surface exists.
    public let surfaceCallbacks: Int
    /// Frames whose IOSurface seed changed: what a viewer would redraw.
    public let seedChanges: Int
}

/// Screen callbacks registered on one device's main display. Callbacks run on a private serial
/// queue and only count: CoreSimulator delivers them synchronously and waits for each.
final class DisplayAttachment: @unchecked Sendable {
    let port: DisplayPort
    private let token = UUID()
    private let queue: DispatchQueue
    private let started = DispatchTime.now()
    private var frameCallbacks = 0
    private var surfaceCallbacks = 0
    private var seedChanges = 0
    private var surface: IOSurfaceRef?
    private var lastSeed: UInt32 = 0

    init(port: DisplayPort) {
        self.port = port
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

    /// Unregisters, then drains callbacks already queued so the final counts are complete.
    func stop() -> DisplayStats {
        port.unregisterCallbacks(token: token)
        return queue.sync { snapshot() }
    }

    private func frame() {
        frameCallbacks += 1
        guard let surface else { return }
        let seed = IOSurfaceGetSeed(surface)
        if seed != lastSeed {
            seedChanges += 1
            lastSeed = seed
        }
    }

    private func surfaceChanged(_ new: IOSurfaceRef?) {
        surfaceCallbacks += 1
        if let new { surface = new }
    }

    private func snapshot() -> DisplayStats {
        let seconds = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e9
        return DisplayStats(
            udid: port.udid, seconds: (seconds * 100).rounded() / 100,
            frameCallbacks: frameCallbacks, surfaceCallbacks: surfaceCallbacks, seedChanges: seedChanges)
    }
}

/// What the registry keeps per device: `DisplayAttachment` in the helper, a stand-in in tests.
protocol RegisteredDisplay: AnyObject, Sendable {
    func start() -> Result<Void, HelperError>
    func stats() -> DisplayStats
    func stop() -> DisplayStats
}

extension DisplayAttachment: RegisteredDisplay {}

/// At most one attachment per device; stage 2b adds the surface handoff to PodNative on top. Remote
/// calls (`start`, a freshness check, `stop`) run outside the lock: a device that is slow to attach
/// marks only its own slot, so stats and detach of every other device go on.
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
    /// (`alreadyAttached`); otherwise starts `make()` in its place. A second attach of the same
    /// device waits for the first, up to `waitLimit`.
    func attach(
        _ udid: String, waitLimit: DispatchTimeInterval = .seconds(5),
        isCurrent: (Display) -> Bool, make: () -> Display
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
        lock.withLock {
            if case .success = started { slots[udid] = .attached(display) } else { slots[udid] = nil }
        }
        if let existing { retire(existing) }
        return started.map { (display, false) }
    }

    /// Final counts; waits out an attach of the same device in progress, up to `waitLimit`.
    func detach(_ udid: String, waitLimit: DispatchTimeInterval = .seconds(5)) -> Result<DisplayStats, HelperError> {
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
            case .stop(let display): return .success(display.stop())
            case .wait(let group):
                if group.wait(timeout: deadline) == .timedOut {
                    return .failure(HelperError(.timeout, "an attach of \(udid) is still running"))
                }
            }
        }
    }

    /// Removes the attachments `shouldDrop` names (devices no longer booted); checked outside the lock.
    func drop(where shouldDrop: (String) -> Bool) {
        let attached = lock.withLock {
            slots.compactMap { entry -> (String, Display)? in
                if case .attached(let display) = entry.value { (entry.key, display) } else { nil }
            }
        }
        for (udid, display) in attached where shouldDrop(udid) {
            let removed = lock.withLock { () -> Bool in
                guard case .attached(let current) = slots[udid], current === display else { return false }
                slots[udid] = nil
                return true
            }
            if removed { retire(display) }
        }
    }

    func detachAll() {
        for udid in lock.withLock({ Array(slots.keys) }) { _ = detach(udid, waitLimit: .seconds(2)) }
    }

    private func retire(_ display: Display) {
        retired.async { _ = display.stop() }
    }
}
