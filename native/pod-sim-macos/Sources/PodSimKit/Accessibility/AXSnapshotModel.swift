import CoreGraphics
import Foundation

/// One element as the translator walk read it: device points, origin top-left (the space HID
/// coordinates use too). Nothing here is normalized yet.
public struct AXRawElement: Equatable, Sendable {
    public var role: String
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var frame: CGRect
    public var enabled: Bool?
    public var focused: Bool?
    public var hidden: Bool
    /// UIAccessibilityTraits bits as the translator reports `AXTraits`.
    public var traits: UInt64?
    public var depth: Int
    /// Whether a hit test at the element's tap point found it (or something inside it); nil when not
    /// tested. False means something else covers that point, so a tap there would miss it.
    public var hitsItself: Bool?

    public init(
        role: String, label: String? = nil, value: String? = nil, identifier: String? = nil, frame: CGRect,
        enabled: Bool? = nil, focused: Bool? = nil, hidden: Bool = false, traits: UInt64? = nil, depth: Int = 1,
        hitsItself: Bool? = nil
    ) {
        self.role = role
        self.label = label
        self.value = value
        self.identifier = identifier
        self.frame = frame
        self.enabled = enabled
        self.focused = focused
        self.hidden = hidden
        self.traits = traits
        self.depth = depth
        self.hitsItself = hitsItself
    }
}

/// UIAccessibilityTraits bits the snapshot reads (UIKit's public values).
enum AXTraitBits {
    static let selected: UInt64 = 1 << 3
    static let notEnabled: UInt64 = 1 << 8
    static let updatesFrequently: UInt64 = 1 << 9
}

public struct AXPoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
}

public struct AXRect: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
}

/// The frozen contract's `SimNode` (src/shared/pod-sim/sim-results.ts), field for field.
public struct AXNode: Codable, Equatable, Sendable {
    /// Position in the whole walk (before filter and cap), so an index from one snapshot names the
    /// same element in the next while the screen holds still.
    public let index: Int
    public let role: String
    public let label: String?
    public let value: String?
    public let id: String?
    /// Where a tap on it lands: the middle of its on-screen part. Frames give the origin.
    public let centre: AXPoint
    public let frame: AXRect
    /// On screen, not hidden, and (when hit-tested) not covered: offered as tappable.
    public let visible: Bool
    public let enabled: Bool?
    public let selected: Bool?
    public let focused: Bool?
}

public struct AXScreen: Codable, Equatable, Sendable {
    /// Device points, in the app's orientation.
    public let width: Double
    public let height: Double
    public let scale: Double
    /// Absent when the tree does not tell (InterfaceOrientation).
    public var orientation: InterfaceOrientation? = nil
}

/// The output budget of the frozen contract (src/shared/pod-sim/sim-call-limits.ts).
public enum AXBudget {
    public static let defaultMaxNodes = 60
    public static let maxNodes = 500
    public static let textMaxChars = 120
    public static let roleMaxChars = 64
    public static let idMaxChars = 256
}

public struct AXSnapshotOptions: Equatable, Sendable {
    public var maxNodes: Int
    /// Case- and diacritic-insensitive substring of label, value or id.
    public var filter: String?
    /// Off-screen and covered nodes too.
    public var all: Bool

    public init(maxNodes: Int = AXBudget.defaultMaxNodes, filter: String? = nil, all: Bool = false) {
        self.maxNodes = min(max(maxNodes, 1), AXBudget.maxNodes)
        self.filter = filter.flatMap { $0.isEmpty ? nil : $0 }
        self.all = all
    }
}

public struct AXNormalized: Equatable, Sendable {
    public let nodes: [AXNode]
    /// Nodes that matched (visible ones unless `all`), before the cap.
    public let total: Int
    public let shown: Int
    /// `total - shown`: the "+N more, use --filter" count.
    public let omitted: Int
    /// Matching nodes left out because they are off screen, hidden or covered (0 with `all`).
    public let notVisible: Int
    /// The tree collapsed to the application element: a system alert, which no tree shows, may
    /// cover the app (stage 0: "Save Password?" left only the app element in every tool).
    public let alertSuspected: Bool
    public let fingerprint: String
}

/// Raw walk to the contract's nodes: centres, visibility, truncation, filter and cap, and the
/// fingerprint stage 2b's settle compares. Pure, so the rules are tested without a device.
public enum AXNormalizer {
    public static func normalize(_ raw: [AXRawElement], screen: AXScreen, options: AXSnapshotOptions) -> AXNormalized {
        let screenRect = CGRect(x: 0, y: 0, width: screen.width, height: screen.height)
        // The application element spans the screen and is never a target.
        let elements = raw.filter { $0.role != "AXApplication" }.map { element in
            var element = element
            element.frame = finite(element.frame)
            return element
        }
        var all: [AXNode] = []
        all.reserveCapacity(elements.count)
        for (index, element) in elements.enumerated() {
            all.append(node(element, index: index, screen: screenRect))
        }
        let matching = all.filter { node in options.filter.map { matches(elements[node.index], $0) } ?? true }
        let eligible = options.all ? matching : matching.filter(\.visible)
        let shown = Array(eligible.prefix(options.maxNodes))
        return AXNormalized(
            nodes: shown, total: eligible.count, shown: shown.count, omitted: eligible.count - shown.count,
            notVisible: matching.count - eligible.count,
            alertSuspected: !raw.isEmpty && elements.isEmpty,
            fingerprint: AXFingerprint.of(elements))
    }

    static func node(_ element: AXRawElement, index: Int, screen: CGRect) -> AXNode {
        let frame = element.frame.standardized
        let onScreen = frame.intersection(screen)
        let visibleArea = !onScreen.isNull && onScreen.width >= 1 && onScreen.height >= 1
        let visible = !element.hidden && frame.width > 0 && frame.height > 0 && visibleArea && element.hitsItself != false
        // The middle of what is on screen, so a half-scrolled row is tapped where it shows.
        let target = visibleArea ? onScreen : frame
        let traits = element.traits ?? 0
        return AXNode(
            index: index,
            role: truncated(element.role, AXBudget.roleMaxChars) ?? "AXUnknown",
            label: truncated(element.label, AXBudget.textMaxChars),
            value: truncated(element.value, AXBudget.textMaxChars),
            id: truncated(element.identifier, AXBudget.idMaxChars),
            centre: AXPoint(x: rounded(target.midX), y: rounded(target.midY)),
            frame: AXRect(x: rounded(frame.minX), y: rounded(frame.minY), width: rounded(frame.width), height: rounded(frame.height)),
            visible: visible,
            enabled: element.enabled.map { $0 && traits & AXTraitBits.notEnabled == 0 } ?? (traits & AXTraitBits.notEnabled != 0 ? false : nil),
            selected: element.traits.map { $0 & AXTraitBits.selected != 0 },
            focused: element.focused)
    }

    /// `filter` as the snapshot applies it (the walk hit-tests only these).
    static func matches(_ element: AXRawElement, _ filter: String) -> Bool {
        [element.label, element.value, element.identifier].contains { text in
            text?.range(of: filter, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    /// Cut to `limit` UTF-16 units (zod's string length) with an ellipsis, never inside a character.
    static func truncated(_ text: String?, _ limit: Int) -> String? {
        guard let text, !text.isEmpty else { return nil }
        guard text.utf16.count > limit else { return text }
        var out = ""
        var units = 0
        for character in text {
            let width = String(character).utf16.count
            if units + width > limit - 1 { break }
            out.append(character)
            units += width
        }
        return out + "\u{2026}"
    }

    static func rounded(_ value: CGFloat) -> Double {
        (Double(value) * 100).rounded() / 100
    }

    /// A frame with a NaN or infinite part (the translator passes on what the app reports) has no place on
    /// screen: zero-size, so it is not visible, and it encodes, so the snapshot does not fail.
    static func finite(_ frame: CGRect) -> CGRect {
        [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height].allSatisfy(\.isFinite) ? frame : .zero
    }
}
