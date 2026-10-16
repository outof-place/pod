import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

/// The Portivo operator app's agenda screen as stage 0 read it (AccessibilityPlatformTranslation on
/// an iPhone 16 Pro, 402x874 points, 2026-10-15): the tab bar at y 786, a card under it, a row
/// half off the bottom, and a carousel running off the right edge and below the screen.
enum AgendaFixture {
    static let screen = AXScreen(width: 402, height: 874, scale: 3)
    static let rows: [(String, String, String?, [CGFloat])] = [
        ("AXApplication", "Portivo Operator", nil, [0, 0, 402, 874]),
        ("AXButton", "Search bookings", nil, [72, 62, 258, 40]),
        ("AXButton", "Activity, new events", nil, [346, 62, 40, 40]),
        ("AXStaticText", "Portivo Operator", nil, [16, 122, 370, 38.67]),
        ("AXButton", "Today", nil, [32, 192.67, 338, 17]),
        ("AXStaticText", "No handovers or returns today", nil, [103.67, 229.67, 194.67, 16]),
        ("AXStaticText", "Last month · PLN (excluding EUR)", nil, [32, 309.67, 250, 16]),
        ("AXButton", "October", nil, [282, 309.67, 88, 24]),
        ("AXStaticText", "-", nil, [32, 328.67, 250, 26.67]),
        ("AXButton", "Booking", nil, [34, 489.33, 52, 75]),
        ("AXButton", "Analytics", nil, [126, 489.33, 54.67, 75]),
        ("AXButton", "Calendar", nil, [221, 489.33, 55, 75]),
        ("AXButton", "Terminal", nil, [316, 489.33, 52, 75]),
        ("AXStaticText", "Activity", nil, [52, 623.67, 43.33, 17]),
        ("AXButton", "Report", nil, [32, 648.33, 338, 64]),
        ("AXButton", "Report", nil, [32, 712.33, 338, 64]),
        ("AXButton", "Mangusta 104 Rev", nil, [32, 776.33, 338, 64]),
        ("AXButton", "See more", nil, [32, 852.33, 338, 42]),
        ("AXStaticText", "Recent customers", nil, [52, 949.67, 108, 17]),
        ("AXButton", "E2E POS Celina", nil, [55.67, 990.33, 97, 76.33]),
        ("AXButton", "E2E POS Filip", nil, [152.67, 990.33, 97, 76.33]),
        ("AXButton", "E2E POS Dorota", nil, [249.67, 990.33, 97, 76.33]),
        ("AXButton", "E2E POS Bartek", nil, [425.67, 990.33, 97, 76.33]),
        ("AXButton", "E2E POS Anna", nil, [522.67, 990.33, 97, 76.33]),
        ("AXButton", "E2E POS Edyta", nil, [619.67, 990.33, 97, 76.33]),
        ("AXButton", "Maestro POS", nil, [844, 990.33, 97, 76.33]),
        ("AXButton", "Zero Override", nil, [941, 990.33, 97, 76.33]),
        ("AXButton", "Start", nil, [16, 786, 74, 62]),
        ("AXButton", "Bookings", nil, [90, 786, 74, 62]),
        ("AXButton", "Calendar", nil, [164, 786, 74, 62]),
        ("AXButton", "Messages", nil, [238, 786, 74, 62]),
        ("AXButton", "More", nil, [312, 786, 74, 62]),
        ("AXButton", "dev-width", "dev-width", [356, 367, 46, 26]),
    ]

    static var raw: [AXRawElement] {
        rows.enumerated().map { index, row in
            AXRawElement(
                role: row.0, label: row.1, identifier: row.2,
                frame: CGRect(x: row.3[0], y: row.3[1], width: row.3[2], height: row.3[3]),
                enabled: true, depth: index == 0 ? 0 : 1)
        }
    }

    static func node(_ label: String, in nodes: [AXNode]) -> AXNode? {
        nodes.first { $0.label == label }
    }
}

@Suite("Accessibility snapshot")
struct AccessibilitySnapshotTests {
    let screen = AgendaFixture.screen

    private func normalize(_ raw: [AXRawElement] = AgendaFixture.raw, _ options: AXSnapshotOptions = AXSnapshotOptions(maxNodes: 500)) -> AXNormalized {
        AXNormalizer.normalize(raw, screen: screen, options: options)
    }

    @Test("a node's tap point is the centre of its frame, not the frame's origin")
    func centreNotOrigin() throws {
        let start = try #require(AgendaFixture.node("Start", in: normalize().nodes))
        #expect(start.frame == AXRect(x: 16, y: 786, width: 74, height: 62))
        #expect(start.centre == AXPoint(x: 53, y: 817))
        let search = try #require(AgendaFixture.node("Search bookings", in: normalize().nodes))
        #expect(search.centre == AXPoint(x: 201, y: 82))
    }

    @Test("a row half off the bottom is tapped in the middle of the part that shows")
    func partlyOnScreen() throws {
        let seeMore = try #require(AgendaFixture.node("See more", in: normalize().nodes))
        #expect(seeMore.visible)
        // 852.33 to the screen's 874, not to the frame's 894.33.
        #expect(seeMore.centre == AXPoint(x: 201, y: 863.17))
    }

    @Test("nodes below the screen or past its right edge are not offered: left out by default, listed as not visible with all")
    func offScreenNotOffered() throws {
        let shown = normalize()
        for label in ["Recent customers", "E2E POS Bartek", "Maestro POS", "E2E POS Celina"] {
            #expect(AgendaFixture.node(label, in: shown.nodes) == nil, "\(label) is off screen")
        }
        // Nine below the screen: "Recent customers" and the eight-card carousel, which also runs off the right.
        #expect(shown.notVisible == 9)
        #expect(shown.total == 23)

        let everything = normalize(AgendaFixture.raw, AXSnapshotOptions(maxNodes: 500, all: true))
        #expect(everything.total == 32)
        #expect(everything.notVisible == 0)
        let bartek = try #require(AgendaFixture.node("E2E POS Bartek", in: everything.nodes))
        #expect(!bartek.visible)
        // The frame still says where it is, so a caller can tell which way to scroll.
        #expect(bartek.frame.x == 425.67)
    }

    @Test("hidden and zero-size nodes are not visible, wherever they sit")
    func hiddenNotOffered() {
        let raw = [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXButton", label: "Behind a sheet", frame: CGRect(x: 20, y: 100, width: 100, height: 44), hidden: true),
            AXRawElement(role: "AXButton", label: "Collapsed", frame: CGRect(x: 20, y: 200, width: 0, height: 44)),
            AXRawElement(role: "AXButton", label: "Shown", frame: CGRect(x: 20, y: 300, width: 100, height: 44)),
        ]
        let result = normalize(raw, AXSnapshotOptions(maxNodes: 500, all: true))
        #expect(result.nodes.map(\.visible) == [false, false, true])
        #expect(normalize(raw).nodes.map(\.label) == ["Shown"])
    }

    @Test("a NaN or infinite frame from the translator becomes zero-size and not visible; the rest of the snapshot stands and encodes")
    func nonFiniteFrame() throws {
        var raw = AgendaFixture.raw
        raw.append(AXRawElement(role: "AXButton", label: "Mid-animation", frame: CGRect(x: CGFloat.nan, y: 10, width: 100, height: 44)))
        raw.append(AXRawElement(role: "AXButton", label: "Unbounded", frame: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 44)))
        let result = normalize(raw, AXSnapshotOptions(maxNodes: 500, all: true))
        let odd = result.nodes.filter { $0.label == "Mid-animation" || $0.label == "Unbounded" }
        #expect(odd.map(\.visible) == [false, false])
        #expect(odd.map(\.frame) == Array(repeating: AXRect(x: 0, y: 0, width: 0, height: 0), count: 2))
        #expect(AgendaFixture.node("Start", in: result.nodes)?.visible == true)
        _ = try WireJSON.encoder.encode(result.nodes)
    }

    @Test("only elements that could be listed are hit-tested: on screen, not hidden, and matching the filter")
    func hitTestCandidates() {
        let screenRect = CGRect(x: 0, y: 0, width: 402, height: 874)
        let start = AXRawElement(role: "AXButton", label: "Start", frame: CGRect(x: 16, y: 786, width: 74, height: 62))
        #expect(AXTreeReader.hitPoint(start, screen: screenRect, filter: nil) == CGPoint(x: 53, y: 817))
        #expect(AXTreeReader.hitPoint(start, screen: screenRect, filter: "start") == CGPoint(x: 53, y: 817))
        #expect(AXTreeReader.hitPoint(start, screen: screenRect, filter: "Bookings") == nil)
        let tab = AXRawElement(role: "AXButton", label: "Tab", identifier: "tab-more", frame: CGRect(x: 312, y: 786, width: 74, height: 62))
        #expect(AXTreeReader.hitPoint(tab, screen: screenRect, filter: "MORE") != nil)
        var hidden = start
        hidden.hidden = true
        #expect(AXTreeReader.hitPoint(hidden, screen: screenRect, filter: nil) == nil)
        let below = AXRawElement(role: "AXButton", label: "Cancel", frame: CGRect(x: 16, y: 1210, width: 370, height: 44))
        #expect(AXTreeReader.hitPoint(below, screen: screenRect, filter: nil) == nil)
        // Half off the bottom: the middle of the part that shows, where a tap would land.
        let seeMore = AXRawElement(role: "AXButton", label: "See more", frame: CGRect(x: 32, y: 852, width: 338, height: 44))
        #expect(AXTreeReader.hitPoint(seeMore, screen: screenRect, filter: nil) == CGPoint(x: 201, y: 863))
    }

    @Test("a hit test runs only where an element outside the node's own family spans its centre")
    func hitTestOnlyPossibleCovers() {
        let screenRect = CGRect(x: 0, y: 0, width: 402, height: 874)
        let elements = [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXGroup", label: "List", frame: CGRect(x: 0, y: 100, width: 402, height: 700)),
            AXRawElement(role: "AXButton", label: "Row", frame: CGRect(x: 16, y: 120, width: 370, height: 44), depth: 2),
            AXRawElement(role: "AXButton", label: "Card", frame: CGRect(x: 32, y: 776, width: 338, height: 64), depth: 2),
            AXRawElement(role: "AXGroup", label: "Tab bar", frame: CGRect(x: 0, y: 786, width: 402, height: 88)),
            AXRawElement(role: "AXButton", label: "Start", frame: CGRect(x: 16, y: 786, width: 74, height: 62), depth: 2),
            AXRawElement(role: "AXGroup", label: "Dimming", frame: CGRect(x: 0, y: 100, width: 402, height: 100), hidden: true),
        ]
        let parents = [-1, 0, 1, 1, 0, 4, 0]
        let points = AXTreeReader.hitPoints(elements, parents: parents, screen: screenRect, filter: nil)
        // The application, the list (only its own rows inside it), and a row inside its list (the
        // hidden dimming view does not count) need none.
        #expect(points[0] == nil)
        #expect(points[1] == nil)
        #expect(points[2] == nil)
        // The card runs under the tab bar, and the tab bar and its Start tab overlap the card.
        #expect(points[3] == CGPoint(x: 201, y: 808))
        #expect(points[4] == CGPoint(x: 201, y: 830))
        #expect(points[5] == CGPoint(x: 53, y: 817))
        #expect(points[6] == nil)
        let filtered = AXTreeReader.hitPoints(elements, parents: parents, screen: screenRect, filter: "card")
        #expect(filtered.compactMap { $0 } == [CGPoint(x: 201, y: 808)])
    }

    @Test("a node a hit test found covered (the card under the tab bar) is not offered")
    func coveredNotOffered() throws {
        var raw = AgendaFixture.raw
        let card = try #require(raw.firstIndex { $0.label == "Mangusta 104 Rev" })
        raw[card].hitsItself = false
        #expect(AgendaFixture.node("Mangusta 104 Rev", in: normalize(raw).nodes) == nil)
        // Untested stays geometric: on screen means visible.
        #expect(AgendaFixture.node("Mangusta 104 Rev", in: normalize().nodes)?.visible == true)
    }

    @Test("indexes count the whole walk without the application element and survive a filter")
    func stableIndexes() throws {
        let all = normalize(AgendaFixture.raw, AXSnapshotOptions(maxNodes: 500, all: true))
        let more = try #require(AgendaFixture.node("More", in: all.nodes))
        #expect(more.index == 30)
        let filtered = normalize(AgendaFixture.raw, AXSnapshotOptions(filter: "more"))
        #expect(filtered.nodes.map(\.label) == ["See more", "More"])
        #expect(filtered.nodes.map(\.index) == [16, 30])
    }

    @Test("the filter ignores case and diacritics and looks at label, value and id")
    func filterRules() {
        let raw = [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXTextField", label: "Guest", value: "Zażółć Gęślą", frame: CGRect(x: 0, y: 100, width: 200, height: 40)),
            AXRawElement(role: "AXButton", label: "Save", identifier: "booking-save", frame: CGRect(x: 0, y: 200, width: 200, height: 40)),
            AXRawElement(role: "AXButton", label: "Cancel", frame: CGRect(x: 0, y: 300, width: 200, height: 40)),
        ]
        #expect(normalize(raw, AXSnapshotOptions(filter: "GESLA")).nodes.map(\.label) == ["Guest"])
        #expect(normalize(raw, AXSnapshotOptions(filter: "BOOKING-")).nodes.map(\.label) == ["Save"])
        #expect(normalize(raw, AXSnapshotOptions(filter: "nothing")).total == 0)
    }

    @Test("the cap holds: 60 by default, maxNodes clamped to 1...500, the rest counted as omitted")
    func outputCap() {
        let many = [AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0)]
            + (0..<700).map { AXRawElement(role: "AXStaticText", label: "Row \($0)", frame: CGRect(x: 0, y: Double($0 % 80) * 10, width: 402, height: 10)) }
        let byDefault = normalize(many, AXSnapshotOptions())
        #expect(byDefault.nodes.count == 60)
        #expect(byDefault.shown == 60)
        #expect(byDefault.total == 700)
        #expect(byDefault.omitted == 640)
        #expect(byDefault.nodes.first?.label == "Row 0")
        #expect(normalize(many, AXSnapshotOptions(maxNodes: 5)).nodes.count == 5)
        #expect(normalize(many, AXSnapshotOptions(maxNodes: 0)).nodes.count == 1)
        #expect(normalize(many, AXSnapshotOptions(maxNodes: 10_000)).nodes.count == 500)
    }

    @Test("long text is cut to 120 UTF-16 units with an ellipsis, never inside a character")
    func textBudget() throws {
        let long = String(repeating: "a", count: 118) + "\u{1F6A4}\u{1F6A4}tail"
        let raw = [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXStaticText", label: long, value: String(repeating: "v", count: 500), frame: CGRect(x: 0, y: 0, width: 10, height: 10)),
        ]
        let node = try #require(normalize(raw).nodes.first)
        let label = try #require(node.label)
        #expect(label.utf16.count <= 120)
        #expect(label == String(repeating: "a", count: 118) + "\u{2026}")
        #expect(node.value?.utf16.count == 120)
        #expect(node.value?.hasSuffix("\u{2026}") == true)
    }

    @Test("a tree that collapsed to the application element suspects a system alert; a normal tree does not")
    func alertSuspected() {
        let appOnly = [AXRawElement(role: "AXApplication", label: "Portivo Operator", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0)]
        #expect(normalize(appOnly).alertSuspected)
        #expect(!normalize().alertSuspected)
    }

    @Test("selected and disabled come from the element and its traits")
    func states() throws {
        let raw = [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXButton", label: "Start", frame: CGRect(x: 16, y: 786, width: 74, height: 62), enabled: true, traits: 1 | AXTraitBits.selected),
            AXRawElement(role: "AXButton", label: "Pay", frame: CGRect(x: 16, y: 700, width: 74, height: 62), enabled: true, traits: 1 | AXTraitBits.notEnabled),
        ]
        let nodes = normalize(raw).nodes
        #expect(nodes[0].selected == true)
        #expect(nodes[0].enabled == true)
        #expect(nodes[1].selected == false)
        #expect(nodes[1].enabled == false)
    }
}

@Suite("Accessibility fingerprint")
struct AccessibilityFingerprintTests {
    private func spinnerScreen(spinnerValue: String, caretFocus: Bool, jitter: CGFloat = 0) -> [AXRawElement] {
        [
            AXRawElement(role: "AXApplication", frame: CGRect(x: 0, y: 0, width: 402, height: 874), depth: 0),
            AXRawElement(role: "AXTextField", label: "Email", value: "you@email.com", frame: CGRect(x: 109, y: 388 + jitter, width: 210, height: 42), focused: caretFocus),
            AXRawElement(role: "AXProgressIndicator", label: "Loading", value: spinnerValue, frame: CGRect(x: 180, y: 600, width: 40, height: 40)),
            AXRawElement(role: "AXStaticText", label: "12 s left", value: spinnerValue, frame: CGRect(x: 20, y: 700, width: 80, height: 20), traits: AXTraitBits.updatesFrequently),
            AXRawElement(role: "AXButton", label: "Sign in", frame: CGRect(x: 68, y: 508, width: 266, height: 44), traits: 1),
        ]
    }

    @Test("a spinner's value, focus moving and sub-point jitter leave the fingerprint alone")
    func ignoresMotion() {
        let base = AXFingerprint.of(spinnerScreen(spinnerValue: "10%", caretFocus: false))
        #expect(AXFingerprint.of(spinnerScreen(spinnerValue: "55%", caretFocus: false)) == base)
        #expect(AXFingerprint.of(spinnerScreen(spinnerValue: "10%", caretFocus: true)) == base)
        #expect(AXFingerprint.of(spinnerScreen(spinnerValue: "10%", caretFocus: false, jitter: 0.3)) == base)
    }

    @Test("a new label, a typed value, a moved element or a selection changes it")
    func seesChanges() {
        let base = AXFingerprint.of(spinnerScreen(spinnerValue: "10%", caretFocus: false))
        var renamed = spinnerScreen(spinnerValue: "10%", caretFocus: false)
        renamed[4].label = "Signing in"
        var typed = spinnerScreen(spinnerValue: "10%", caretFocus: false)
        typed[1].value = "you@email.co"
        var selected = spinnerScreen(spinnerValue: "10%", caretFocus: false)
        selected[4].traits = 1 | AXTraitBits.selected
        let changes = [
            AXFingerprint.of(renamed), AXFingerprint.of(typed), AXFingerprint.of(selected),
            AXFingerprint.of(spinnerScreen(spinnerValue: "10%", caretFocus: false, jitter: 40)),
        ]
        for changed in changes {
            #expect(changed != base)
        }
        #expect(base.count == 16)
    }
}
