import Foundation

/// The self-test's `ax` checks: the translator loads and has every selector the walk calls, then (on a
/// booted device) one read answers. Reading the tree changes nothing on the device. On `parallelWalk`
/// the notes say when reads go through the translator instead, and why.
enum AccessibilityProbes {
    static func symbols() -> ProbeOutcome {
        switch AXTranslatorBridge.shared() {
        case .failure(let error): return .failed(checked: .symbols, reason: error.message)
        case .success: return .passed(checked: .symbols, note: AccessibilitySnapshots.route.note)
        }
    }

    static func device(_ device: SimDeviceHandle) -> ProbeOutcome {
        switch AccessibilitySnapshots.take(device, options: AXSnapshotOptions(maxNodes: 1), hitTest: false) {
        case .failure(let error):
            return .failed(checked: .device, reason: error.message)
        case .success(let snapshot):
            let elements = snapshot.total + snapshot.notVisible
            let app = snapshot.app.map { "app pid \($0.pid)" } ?? "no app pid"
            let read = snapshot.basis.map { " (\($0.rawValue))" } ?? ""
            let fallback = [snapshot.fallbackReason, AccessibilitySnapshots.route.note].compactMap { $0 }.first.map { "; through the translator: \($0)" } ?? ""
            return .passed(checked: .device, note: "\(elements) elements under the frontmost application (\(app)) in \(snapshot.ms) ms\(read)\(fallback)")
        }
    }
}
