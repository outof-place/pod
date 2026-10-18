import Foundation

/// The parallel route's recent failures, per device boot. Two in a row for a reason that does not
/// pass by itself (anything but the budget) pause it for `pauseSeconds`, and every failure after a
/// pause starts another, so a broken route costs one try per pause instead of up to a request
/// timeout (1.5 s) on every call; a success starts over. Each reason is logged once per device boot.
final class AXParallelBackoff: @unchecked Sendable {
    struct Key: Hashable, Sendable {
        let udid: String
        let boot: Date?
    }

    /// Agents read every few seconds: one try in 30 s keeps a dead route to a few percent of their reads.
    static let pauseSeconds: Double = 30
    static let failuresBeforePause = 2
    static let shared = AXParallelBackoff(pauseSeconds: pauseSeconds)

    private struct State {
        var failures = 0
        var pausedUntil: DispatchTime?
        var reason = ""
        var told: Set<String> = []
    }

    private let pauseSeconds: Double
    private let lock = NSLock()
    private var states: [Key: State] = [:]

    init(pauseSeconds: Double) {
        self.pauseSeconds = pauseSeconds
    }

    /// Why parallel reads of this device boot are paused, while they are.
    func paused(_ key: Key, now: DispatchTime = .now()) -> String? {
        lock.withLock {
            guard let state = states[key], let until = state.pausedUntil, now < until else { return nil }
            return "parallel reads paused for \(Int(pauseSeconds)) s after \(Self.failuresBeforePause) failures in a row (\(state.reason))"
        }
    }

    func succeeded(_ key: Key) {
        lock.withLock {
            states[key]?.failures = 0
            states[key]?.pausedUntil = nil
        }
    }

    /// Counts a failure; what to log, the first time this reason comes up for the device boot.
    func failed(_ key: Key, _ failure: AXParallelFailure, now: DispatchTime = .now()) -> String? {
        lock.withLock {
            // A new boot of the device starts over.
            for other in states.keys where other.udid == key.udid && other != key { states[other] = nil }
            var state = states[key] ?? State()
            var pauses = false
            if failure.kind != .budget {
                state.failures += 1
                state.reason = failure.error.message
                if state.failures >= Self.failuresBeforePause {
                    state.pausedUntil = now + pauseSeconds
                    pauses = true
                }
            }
            let told = state.told.insert(pauses ? "\(failure.kind.rawValue) pause" : failure.kind.rawValue).inserted
            states[key] = state
            guard told else { return nil }
            let next = switch (failure.kind, pauses) {
            case (.budget, _): "nothing is left of the budget for the translator"
            case (_, true): "the next \(Int(pauseSeconds)) s read through the translator"
            case (_, false): "reading through the translator"
            }
            return "ax \(key.udid): \(failure.error.message); \(next)"
        }
    }
}

/// `ax` on the parallel route, and where it goes when that read fails.
enum AXParallelFallback {
    /// The parallel answer, or the translator's (`basis: translator`, `fallbackReason` saying why the
    /// parallel read failed or was skipped). A read past its budget leaves the translator none, so it
    /// is answered as it failed. `force` tries the parallel read even while paused (the self-test).
    static func answer(
        key: AXParallelBackoff.Key, backoff: AXParallelBackoff, force: Bool,
        parallel: () -> Result<AXSnapshotResult, AXParallelFailure>,
        translator: () -> Result<AXSnapshotResult, HelperError>,
        log: (String) -> Void
    ) -> Result<AXSnapshotResult, HelperError> {
        let reason: String
        if !force, let paused = backoff.paused(key) {
            reason = paused
        } else {
            switch parallel() {
            case .success(let result):
                backoff.succeeded(key)
                return .success(result)
            case .failure(let failure):
                if let note = backoff.failed(key, failure) { log(note) }
                if failure.kind == .budget { return .failure(failure.error) }
                reason = failure.error.message
            }
        }
        return translator()
            .map { taken in
                var result = taken
                result.basis = .translator
                result.fallbackReason = reason
                return result
            }
            .mapError { HelperError($0.code, "\(reason); through the translator: \($0.message)") }
    }
}
