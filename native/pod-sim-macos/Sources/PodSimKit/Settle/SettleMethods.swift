import Foundation

/// `settle`'s answer. Regions are points in the device's native (portrait) orientation.
public struct SettleResult: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable {
        case settled, settledWithMotion
    }

    public let udid: String
    public let outcome: Outcome
    public let waitedMs: Int
    public let windowMs: Int
    /// What decided: pixels and the accessibility tree, pixels alone (no translator for this build,
    /// or its reads failed), or the tree alone (no live display).
    public let basis: String
    /// Regions that kept the screen from settling, largest first; empty when settled.
    public let motion: [PointRect]
    /// Small regions still moving that settle allowed (a caret, a spinner).
    public let ignored: [PointRect]
    /// The last two accessibility reads agreed; absent without a tree.
    public let treeStable: Bool?
    public let fingerprint: String?
    /// The tree collapsed to the application element (see `ax`).
    public let alertSuspected: Bool?
    /// Framebuffer hashes taken while settling, and their mean time.
    public let hashes: Int
    public let hashMicros: Double
    public let treeReads: Int
}

private struct SettleParams: Decodable {
    let udid: String
    let windowMs: Int?
    let timeoutMs: Int?
    let smallPt: Double?
}

/// The live signals: the device's attachment for pixels, the translator for the tree.
private final class LiveSettleSignals: SettleSignals {
    let watch: DamageWatch?
    let scale: Double
    let options: SettleOptions
    let knownSinceNs: UInt64
    let device: SimDeviceHandle
    let readsTree: Bool

    init(watch: DamageWatch?, scale: Double, options: SettleOptions, knownSinceNs: UInt64, device: SimDeviceHandle, readsTree: Bool) {
        self.watch = watch
        self.scale = scale
        self.options = options
        self.knownSinceNs = knownSinceNs
        self.device = device
        self.readsTree = readsTree
    }

    func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

    var watchesPixels: Bool { watch != nil }

    func motion(sinceNs: UInt64) -> MotionSplit {
        guard let watch else { return .none }
        return DamageMap.split(watch.regions(sinceNs: sinceNs), scale: scale, smallPt: options.smallPt, maxSmall: options.maxSmall)
    }

    func waitForChange(untilNs: UInt64) {
        if let watch {
            watch.waitForChange(untilNs: untilNs)
        } else {
            let now = self.now()
            if untilNs > now { usleep(useconds_t(min(UInt64(UInt32.max), (untilNs - now) / 1_000))) }
        }
    }

    func readTree() -> TreeRead? {
        let options = AXSnapshotOptions(maxNodes: 1, filter: nil, all: false)
        guard case .success(let snapshot) = AccessibilitySnapshots.take(device, options: options, hitTest: false) else { return nil }
        return TreeRead(fingerprint: snapshot.fingerprint, alertSuspected: snapshot.alertSuspected)
    }
}

extension HelperMethods {
    func settle(_ params: Data) -> Reply {
        decode(SettleParams.self, params) { params in
            guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
            var options = SettleOptions()
            options.windowMs = params.windowMs ?? options.windowMs
            options.timeoutMs = params.timeoutMs ?? options.timeoutMs
            options.smallPt = params.smallPt ?? options.smallPt
            guard SettleOptions.windowMsRange.contains(options.windowMs), SettleOptions.timeoutMsRange.contains(options.timeoutMs),
                  SettleOptions.smallPtRange.contains(options.smallPt)
            else {
                return .error(HelperError(.badParams, "windowMs 100 to 5000, timeoutMs 200 to 20000, smallPt 1 to 200"))
            }
            guard options.timeoutMs >= options.windowMs else {
                return .error(HelperError(.badParams, "timeoutMs must be at least windowMs"))
            }
            let displayOK = startupReport.capabilities.display.status == .ok
            let treeOK = startupReport.capabilities.ax.status == .ok
            guard displayOK || treeOK else {
                return .error(HelperError(.unsupported, "settle needs display or ax: \(startupReport.capabilities.display.reason ?? "display is off")"))
            }
            let udid = params.udid.uppercased()
            let device: SimDeviceHandle
            switch booted(udid) {
            case .failure(let error): return .error(error)
            case .success(let found): device = found
            }
            var watched: (DisplayAttachment, DamageWatch)?
            var knownSince = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
            if displayOK {
                // The watch joins under the lock: as an observer it holds the attachment against a stopStream.
                let attached = deviceLocks.withLock(udid) {
                    ensureAttached(udid).flatMap { attachment, already -> Result<(DisplayAttachment, Bool, DamageWatch), HelperError> in
                        let watch = DamageWatch { attachment.currentSurface }
                        guard watch.start() else {
                            watch.stop()
                            if !attachment.isHeld, displays.attachment(udid) === attachment { _ = displays.detach(udid, reason: nil) }
                            return .failure(HelperError(.failed, "the framebuffer cannot be hashed (no surface, or not 4 bytes per pixel)"))
                        }
                        attachment.addObserver(watch)
                        return .success((attachment, already, watch))
                    }
                }
                switch attached {
                case .failure(let error):
                    guard treeOK else { return .error(error) }
                    HelperLog.note("settle \(udid): no display (\(error.message)); settling on the tree alone")
                case .success(let (attachment, already, watch)):
                    // An attachment that saw no frame for a while vouches for the screen before this call.
                    if already { knownSince = min(knownSince, attachment.lastFrameAtNs ?? attachment.attachedAtNs) }
                    watched = (attachment, watch)
                }
            }
            defer {
                if let (attachment, watch) = watched {
                    attachment.removeObserver(watch)
                    watch.stop()
                    deviceLocks.withLock(udid) {
                        if !attachment.isHeld, displays.attachment(udid) === attachment { _ = displays.detach(udid, reason: nil) }
                    }
                }
            }
            let scale = watched?.0.scale ?? DeviceScreen.of(device).scale
            let signals = LiveSettleSignals(
                watch: watched?.1, scale: scale, options: options, knownSinceNs: knownSince, device: device, readsTree: treeOK)
            let outcome = SettleLoop.run(options, signals)
            let cost = watched?.1.cost ?? (hashes: 0, meanMicros: 0)
            return .encoding(SettleResult(
                udid: udid, outcome: outcome.settled ? .settled : .settledWithMotion, waitedMs: outcome.waitedMs,
                windowMs: options.windowMs, basis: outcome.basis.rawValue,
                motion: outcome.motion.blocking.map { PointRect($0, scale: scale) },
                ignored: outcome.motion.ignored.map { PointRect($0, scale: scale) },
                treeStable: outcome.treeStable, fingerprint: outcome.tree?.fingerprint, alertSuspected: outcome.tree?.alertSuspected,
                hashes: cost.hashes, hashMicros: cost.meanMicros, treeReads: outcome.treeReads))
        }
    }
}
