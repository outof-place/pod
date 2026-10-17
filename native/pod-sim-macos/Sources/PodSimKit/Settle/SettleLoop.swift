import Foundation

struct SettleOptions: Equatable, Sendable {
    static let windowMsRange = 100...5_000
    static let timeoutMsRange = 200...20_000
    static let smallPtRange = 1.0...200.0

    /// How long the screen must stay still (nothing but small regions moving).
    var windowMs = 400
    var timeoutMs = 5_000
    /// A moving region at most this many points on each side is ignored (a caret, a spinner).
    var smallPt = 48.0
    var maxSmall = 4
}

/// One accessibility read: stage 3's fingerprint ignores focus, carets and busy indicators' values.
struct TreeRead: Equatable, Sendable {
    let fingerprint: String
    let alertSuspected: Bool
}

/// What settle watches. Times are CLOCK_UPTIME_RAW nanoseconds.
protocol SettleSignals: AnyObject {
    func now() -> UInt64
    /// Pixels are watched: `motion` answers.
    var watchesPixels: Bool { get }
    /// Before the watch began, the screen is known not to have changed since this time (an older
    /// attachment saw no frame since); the watch's own start otherwise.
    var knownSinceNs: UInt64 { get }
    /// What moved after `sinceNs`.
    func motion(sinceNs: UInt64) -> MotionSplit
    /// Returns when the screen changes or at `untilNs`, whichever comes first.
    func waitForChange(untilNs: UInt64)
    var readsTree: Bool { get }
    /// nil when the read failed: settle goes on from pixels alone.
    func readTree() -> TreeRead?
}

enum SettleBasis: String, Codable, Sendable {
    case pixelsAndTree, pixels, tree
}

struct SettleOutcome: Equatable, Sendable {
    let settled: Bool
    let waitedMs: Int
    let basis: SettleBasis
    /// What still moved at the end: blocking regions (empty when settled) and ignored small ones.
    let motion: MotionSplit
    /// Two reads in a row agreed; nil without a tree.
    let treeStable: Bool?
    let tree: TreeRead?
    let treeReads: Int
}

/// Settled: nothing but small regions moved for a whole window, and two accessibility reads made
/// inside that still window agree. Without pixels, two reads a window apart must agree, and with
/// neither nothing is settled. A screen that never settles answers at the timeout with what was
/// moving: never an error.
enum SettleLoop {
    static let pollNs: UInt64 = 50_000_000

    static func run(_ options: SettleOptions, _ signals: SettleSignals) -> SettleOutcome {
        let started = signals.now()
        let window = UInt64(options.windowMs) * 1_000_000
        let deadline = started + UInt64(options.timeoutMs) * 1_000_000
        let pixels = signals.watchesPixels
        var readsTree = signals.readsTree
        var previous: (read: TreeRead, startedNs: UInt64)?
        var lastRead: TreeRead?
        var reads = 0
        var stableAtEnd: Bool?

        func outcome(_ settled: Bool, motion: MotionSplit) -> SettleOutcome {
            let basis: SettleBasis = pixels ? (reads > 0 && readsTree ? .pixelsAndTree : .pixels) : .tree
            return SettleOutcome(
                settled: settled, waitedMs: Int((signals.now() - started) / 1_000_000), basis: basis, motion: motion,
                treeStable: reads > 0 ? stableAtEnd ?? false : nil, tree: lastRead, treeReads: reads)
        }

        while true {
            let now = signals.now()
            let recent = pixels ? signals.motion(sinceNs: now > window ? now - window : 0) : .none
            let still = !pixels || (now >= signals.knownSinceNs + window && recent.blocking.isEmpty)
            if !still {
                if now >= deadline { return outcome(false, motion: recent) }
                signals.waitForChange(untilNs: min(deadline, now + pollNs))
                continue
            }
            // Blind (no pixels, no tree): nothing says the screen stopped.
            if !readsTree { return outcome(pixels, motion: recent) }
            let readStarted = signals.now()
            guard let read = signals.readTree() else {
                readsTree = false
                if !pixels { return outcome(false, motion: .none) }
                continue
            }
            reads += 1
            lastRead = read
            if let previous, previous.read.fingerprint == read.fingerprint {
                let quietSince = pixels
                    ? signals.motion(sinceNs: previous.startedNs).blocking.isEmpty
                    : signals.now() >= previous.startedNs + window
                if quietSince {
                    stableAtEnd = true
                    return outcome(true, motion: pixels ? signals.motion(sinceNs: signals.now() - min(window, signals.now())) : .none)
                }
            }
            stableAtEnd = previous.map { $0.read.fingerprint == read.fingerprint }
            previous = (read, readStarted)
            let after = signals.now()
            if after >= deadline {
                return outcome(false, motion: pixels ? signals.motion(sinceNs: after - min(window, after)) : .none)
            }
            // A tree alone is read a window apart; a changing tree on a still screen is read again a
            // little later rather than back to back.
            if !pixels {
                signals.waitForChange(untilNs: min(deadline, readStarted + window))
            } else if stableAtEnd == false {
                signals.waitForChange(untilNs: min(deadline, after + window / 4))
            }
        }
    }
}
