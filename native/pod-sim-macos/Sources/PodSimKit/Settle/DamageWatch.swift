import CPodSimSurface
import Foundation
import IOSurface

/// What changed on one device's screen while a settle runs: tile hashes of the framebuffer compared
/// frame to frame, at most `minIntervalNs` apart (a frame that comes sooner is folded into the next
/// hash, which still sees its change, and the last frame always gets one). Runs only during a settle;
/// the live view never pays for it.
final class DamageWatch: FrameObserver, @unchecked Sendable {
    /// 30 hashes a second at most: about 1 ms each on a 1206x2622 framebuffer.
    static let minIntervalNs: UInt64 = 33_000_000
    static let maxSamples = 256

    private struct Sample {
        let atNs: UInt64
        let bits: TileBits
    }

    private let surfaceSource: () -> IOSurfaceRef?
    private let queue = DispatchQueue(label: "pod-sim.settle.damage", qos: .userInitiated)
    private let signal: DispatchSourceUserDataAdd
    private var grid: TileGrid?
    private var surfaceID: UInt32?
    private var previous: [UInt64] = []
    private var current: [UInt64] = []
    private var lastHashNs: UInt64 = 0
    private var trailing: DispatchSourceTimer?
    private var stopped = false
    // Read from the settle loop's thread, written on `queue`: guarded by `changed`.
    private let changed = NSCondition()
    private var samples: [Sample] = []
    private var generation = 0
    private var hashes = 0
    private var hashNanos: UInt64 = 0

    init(surface: @escaping () -> IOSurfaceRef?) {
        surfaceSource = surface
        signal = DispatchSource.makeUserDataAddSource(queue: queue)
    }

    /// Listens, and hashes the screen as it is now: the baseline later frames are compared with.
    /// False when there is no baseline (no surface, or not 4 bytes per pixel): this watch sees no pixels.
    func start() -> Bool {
        signal.setEventHandler { [weak self] in self?.frameSignalled() }
        signal.activate()
        return queue.sync { hash(at: clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) }
    }

    func stop() {
        signal.cancel()
        queue.sync {
            stopped = true
            trailing?.cancel()
            trailing = nil
        }
        changed.lock()
        generation += 1
        changed.broadcast()
        changed.unlock()
    }

    /// From the attachment's queue: no allocation, no wait.
    func frameArrived() { signal.add(data: 1) }

    /// Hashes taken and their mean time in microseconds.
    var cost: (hashes: Int, meanMicros: Double) {
        queue.sync { (hashes, hashes > 0 ? (Double(hashNanos) / Double(hashes) / 100).rounded() / 10 : 0) }
    }

    /// Tiles that changed after `sinceNs`, as regions in pixels.
    func regions(sinceNs: UInt64) -> [PixelRect] {
        guard let grid = queue.sync(execute: { grid }) else { return [] }
        var union = TileBits(count: grid.count)
        changed.lock()
        for sample in samples.reversed() {
            guard sample.atNs > sinceNs else { break }
            if sample.bits.words.count == union.words.count { union.formUnion(sample.bits) }
        }
        changed.unlock()
        return DamageMap.regions(union, grid: grid)
    }

    /// Returns at the next damage sample or at `untilNs`.
    func waitForChange(untilNs: UInt64) {
        changed.lock()
        defer { changed.unlock() }
        let seen = generation
        while generation == seen {
            let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
            guard now < untilNs else { return }
            _ = changed.wait(until: Date(timeIntervalSinceNow: Double(untilNs - now) / 1e9))
        }
    }

    private func frameSignalled() {
        guard !stopped else { return }
        let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        if now >= lastHashNs + Self.minIntervalNs {
            _ = hash(at: now)
        } else if trailing == nil {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + .nanoseconds(Int(lastHashNs + Self.minIntervalNs - now)))
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.trailing?.cancel()
                self.trailing = nil
                if !self.stopped { _ = self.hash(at: clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) }
            }
            trailing = timer
            timer.activate()
        }
    }

    /// False when the surface could not be read.
    private func hash(at now: UInt64) -> Bool {
        guard let surface = surfaceSource() else { return false }
        let id = IOSurfaceGetID(surface)
        let shape = TileGrid(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface))
        let fresh = grid != shape || surfaceID != id
        if fresh {
            grid = shape
            surfaceID = id
            current = [UInt64](repeating: 0, count: shape.count)
            previous = [UInt64](repeating: 0, count: shape.count)
        }
        let started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        var before: UInt32 = 0, after: UInt32 = 0
        let read = current.withUnsafeMutableBufferPointer { buffer in
            pod_sim_tile_hashes(Unmanaged.passUnretained(surface).toOpaque(), UInt32(shape.tile), buffer.baseAddress, buffer.count, &before, &after)
        }
        lastHashNs = now
        guard read == 0 else { return false }
        hashes += 1
        hashNanos += clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started
        defer { swap(&previous, &current) }
        // The first hash of a surface is the baseline; a surface swapped mid-watch changed everywhere.
        if fresh && hashes == 1 { return true }
        var bits = TileBits(count: shape.count)
        if fresh {
            for i in 0..<shape.count { bits.insert(i) }
        } else {
            DamageMap.changed(previous: previous, current: current, into: &bits)
        }
        guard !bits.isEmpty else { return true }
        changed.lock()
        samples.append(Sample(atNs: now, bits: bits))
        if samples.count > Self.maxSamples { samples.removeFirst(samples.count - Self.maxSamples) }
        generation += 1
        changed.broadcast()
        changed.unlock()
        return true
    }
}
