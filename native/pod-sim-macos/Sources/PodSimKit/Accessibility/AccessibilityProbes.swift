import Foundation

/// The self-test's `ax` checks: the translator loads and has every selector the walk calls, then (on a
/// booted device) one read answers. Reading the tree changes nothing on the device. On `parallelWalk`
/// the notes say when reads go through the translator instead, and why, and when no tree is kept.
enum AccessibilityProbes {
    /// How long the device check waits for the notification connection's first answer.
    static let listenWaitSeconds: TimeInterval = 1

    static func symbols() -> ProbeOutcome {
        switch AXTranslatorBridge.shared() {
        case .failure(let error): return .failed(checked: .symbols, reason: error.message)
        case .success: return .passed(checked: .symbols, note: AccessibilitySnapshots.route.note)
        }
    }

    static func device(_ device: SimDeviceHandle) -> ProbeOutcome {
        // In parallel even while that route is paused for the device: the note says how it is now.
        switch AccessibilitySnapshots.take(device, options: AXSnapshotOptions(maxNodes: 1), hitTest: false, force: true) {
        case .failure(let error):
            return .failed(checked: .device, reason: error.message)
        case .success(let snapshot):
            let unheard = snapshot.basis == .parallel
                ? AXDeviceSessions.shared.existing(device.udid)?.listenProblem(within: listenWaitSeconds)
                : nil
            return .passed(checked: .device, note: note(snapshot, routeNote: AccessibilitySnapshots.route.note, listenProblem: unheard))
        }
    }

    static func note(_ snapshot: AXSnapshotResult, routeNote: String?, listenProblem: String?) -> String {
        let elements = snapshot.total + snapshot.notVisible
        let app = snapshot.app.map { "app pid \($0.pid)" } ?? "no app pid"
        let read = snapshot.basis.map { " (\($0.rawValue))" } ?? ""
        let fallback = [snapshot.fallbackReason, routeNote].compactMap { $0 }.first.map { "; through the translator: \($0)" } ?? ""
        let unkept = listenProblem.map { "; no tree is kept: \($0)" } ?? ""
        return "\(elements) elements under the frontmost application (\(app)) in \(snapshot.ms) ms\(read)\(fallback)\(unkept)"
    }
}
