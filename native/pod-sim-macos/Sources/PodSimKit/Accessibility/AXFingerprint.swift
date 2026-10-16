import CryptoKit
import Foundation

/// A stable digest of what the tree says is on screen, for stage 2b's settle: two reads with the
/// same fingerprint showed the same elements in the same places. It leaves out what moves while
/// nothing happens: the value of anything that updates on its own (a spinner, a progress bar, a
/// clock: UIKit's updatesFrequently trait or a progress role), focus (the caret's field), and
/// sub-point jitter in frames. The caret itself is not in the tree.
public enum AXFingerprint {
    static let motionRoles: Set<String> = ["AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator"]

    public static func of(_ elements: [AXRawElement]) -> String {
        var hasher = SHA256()
        for element in elements {
            hasher.update(data: Data(line(element).utf8))
        }
        return hasher.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func line(_ element: AXRawElement) -> String {
        let moving = motionRoles.contains(element.role) || (element.traits ?? 0) & AXTraitBits.updatesFrequently != 0
        let frame = element.frame.standardized
        let box = [frame.minX, frame.minY, frame.width, frame.height].map { String(Int(($0).rounded())) }.joined(separator: ",")
        // Selected and enabled stay: a tab switching or a button enabling is a change to wait for.
        let traits = (element.traits ?? 0) & (AXTraitBits.selected | AXTraitBits.notEnabled)
        return [
            element.role, element.label ?? "", element.identifier ?? "", moving ? "" : (element.value ?? ""), box,
            element.hidden ? "h" : "", element.enabled == false ? "d" : "", String(traits), String(element.depth),
        ].joined(separator: "\u{1f}") + "\u{1e}"
    }
}
