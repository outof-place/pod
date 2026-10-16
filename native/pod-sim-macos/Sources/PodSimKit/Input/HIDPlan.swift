import CoreGraphics
import Foundation

/// A point as DTUHID wants it: the screen's top-left is (0, 0) and its bottom-right (1, 1).
struct NormalizedPoint: Equatable, Sendable {
    let x: Double
    let y: Double
}

/// `IndigoDigitizerEvent.eventType` (idb v1.7.2 `DigitizerEventType`): per contact, uint64.
enum DigitizerPhase: UInt64, Sendable {
    case start = 0, position = 1, end = 2
}

/// `IndigoDigitizerEvent.edge` (idb v1.7.2 `SimulatorHIDEdge`): set on every contact of an edge gesture.
enum DigitizerEdge: UInt64, Sendable {
    case none = 0, top = 1, left = 2, bottom = 3, right = 4

    init(_ edge: HIDEdge?) {
        switch edge {
        case nil: self = .none
        case .top: self = .top
        case .left: self = .left
        case .bottom: self = .bottom
        case .right: self = .right
        }
    }
}

/// `dtuhidd`'s `HIDButtonState` is 1-based: 0 is refused at decode (idb v1.7.2).
enum HIDButtonState: UInt64, Sendable {
    case down = 1, up = 2
}

struct DigitizerContact: Equatable, Sendable {
    let phase: DigitizerPhase
    let first: NormalizedPoint
    let second: NormalizedPoint?
    let edge: DigitizerEdge
}

enum DTUHIDEvent: Equatable, Sendable {
    case digitizer(DigitizerContact)
    case key(usage: UInt16, state: HIDButtonState)
    case button(page: UInt16, usage: UInt16, state: HIDButtonState)
}

enum HIDStep: Equatable, Sendable {
    case send(DTUHIDEvent)
    case wait(ms: Double)
}

/// Device points to DTUHID events and waits. Pure: every gesture's shape is tested without a device.
enum HIDPlan {
    /// About one sample per display frame while a contact moves.
    static let sampleMs = 16.0
    /// Gaps around a key, as stage 0 typed 100 of 100 characters exactly.
    static let keyGapMs = 12.0
    static let modifierGapMs = 20.0

    static func normalized(_ point: DevicePoint, screen: CGSize) -> NormalizedPoint {
        NormalizedPoint(x: min(max(point.x / Double(screen.width), 0), 1), y: min(max(point.y / Double(screen.height), 0), 1))
    }

    /// Points outside the screen are refused, not clamped: a tap at the wrong place is worse than none.
    static func outside(_ action: HIDAction, screen: CGSize) -> DevicePoint? {
        let points: [DevicePoint]
        switch action {
        case .tap(let at, _), .longPress(let at, _): points = [at]
        case .swipe(let from, let to, _, _), .drag(let from, let to, _, _, _): points = [from, to]
        case .pinch(let centre, let fromSpan, let toSpan, _, let angle):
            let start = pinchPoints(centre, span: fromSpan, angle: angle), end = pinchPoints(centre, span: toSpan, angle: angle)
            points = [start.0, start.1, end.0, end.1]
        case .touch(_, let touched, _): points = touched
        case .text, .key, .button: points = []
        }
        return points.first { !$0.x.isFinite || !$0.y.isFinite || $0.x < 0 || $0.y < 0 || $0.x > Double(screen.width) || $0.y > Double(screen.height) }
    }

    static func steps(_ action: HIDAction, screen: CGSize) -> [HIDStep] {
        func contact(_ phase: DigitizerPhase, _ point: DevicePoint, _ second: DevicePoint? = nil, edge: HIDEdge? = nil) -> HIDStep {
            .send(.digitizer(DigitizerContact(
                phase: phase, first: normalized(point, screen: screen), second: second.map { normalized($0, screen: screen) },
                edge: DigitizerEdge(edge))))
        }
        switch action {
        case .tap(let at, let hold), .longPress(let at, let hold):
            return [contact(.start, at), .wait(ms: Double(hold)), contact(.end, at)]
        case .swipe(let from, let to, let duration, let edge):
            // A last sample held at the end, so the content stops where the finger lifts (idb's swipe:
            // no inertial scroll), and the edge flag on every contact so iOS reads a system gesture.
            let samples = max(1, Int((Double(duration) / sampleMs).rounded()))
            let step = Double(duration) / Double(samples + 1)
            var steps = [contact(.start, from, edge: edge)]
            for index in 1...samples {
                steps += [.wait(ms: step), contact(.position, lerp(from, to, Double(index) / Double(samples)), edge: edge)]
            }
            steps += [.wait(ms: step), contact(.position, to, edge: edge), contact(.end, to, edge: edge)]
            return steps
        case .drag(let from, let to, let press, let travel, let release):
            let samples = max(1, Int((Double(travel) / sampleMs).rounded()))
            var steps = [contact(.start, from), .wait(ms: Double(press))]
            for index in 1...samples {
                steps += [.wait(ms: Double(travel) / Double(samples)), contact(.position, lerp(from, to, Double(index) / Double(samples)))]
            }
            steps += [.wait(ms: Double(release)), contact(.end, to)]
            return steps
        case .pinch(let centre, let fromSpan, let toSpan, let duration, let angle):
            let samples = max(1, Int((Double(duration) / sampleMs).rounded()))
            let start = pinchPoints(centre, span: fromSpan, angle: angle)
            var steps = [contact(.start, start.0, start.1)]
            for index in 1...samples {
                let span = fromSpan + (toSpan - fromSpan) * Double(index) / Double(samples)
                let points = pinchPoints(centre, span: span, angle: angle)
                steps += [.wait(ms: Double(duration) / Double(samples)), contact(.position, points.0, points.1)]
            }
            let end = pinchPoints(centre, span: toSpan, angle: angle)
            steps.append(contact(.end, end.0, end.1))
            return steps
        case .touch(let phase, let points, let edge):
            let mapped: DigitizerPhase = switch phase {
            case .down: .start
            case .move: .position
            case .up: .end
            }
            return [contact(mapped, points[0], points.count > 1 ? points[1] : nil, edge: edge)]
        case .key(let usage, let modifiers, let phase):
            let held = modifiers.compactMap { KeyboardUsage.modifiers[$0] }
            let down = held.flatMap { [HIDStep.send(.key(usage: $0, state: .down)), .wait(ms: modifierGapMs)] } + [.send(.key(usage: usage, state: .down))]
            let up = [HIDStep.send(.key(usage: usage, state: .up))] + held.reversed().flatMap { [HIDStep.wait(ms: modifierGapMs), .send(.key(usage: $0, state: .up))] }
            switch phase {
            case .down: return down
            case .up: return up
            case .press: return down + [.wait(ms: modifierGapMs)] + up
            }
        case .button(let button, let hold):
            let usage = button.usage
            return [.send(.button(page: usage.page, usage: usage.code, state: .down)), .wait(ms: Double(hold)),
                    .send(.button(page: usage.page, usage: usage.code, state: .up))]
        case .text(let text, _):
            return typing(text)
        }
    }

    /// One key per character on a US layout; nil-usage characters never reach here (TextRoute).
    static func typing(_ text: String) -> [HIDStep] {
        var steps: [HIDStep] = []
        for character in text {
            guard let (usage, shift) = KeyboardUsage.usage(for: character) else { continue }
            if shift { steps.append(.send(.key(usage: KeyboardUsage.leftShift, state: .down))) }
            steps += [.send(.key(usage: usage, state: .down)), .wait(ms: keyGapMs), .send(.key(usage: usage, state: .up))]
            if shift { steps.append(.send(.key(usage: KeyboardUsage.leftShift, state: .up))) }
            steps.append(.wait(ms: keyGapMs))
        }
        return steps
    }

    /// Cmd+V, as a person pastes.
    static var paste: [HIDStep] {
        steps(.key(usage: KeyboardUsage.v, modifiers: ["command"], phase: .press), screen: .zero)
    }

    static func plannedMs(_ steps: [HIDStep]) -> Double {
        steps.reduce(0) { total, step in if case .wait(let ms) = step { total + ms } else { total } }
    }

    static func pinchPoints(_ centre: DevicePoint, span: Double, angle: Double) -> (DevicePoint, DevicePoint) {
        let radians = angle * .pi / 180
        let dx = cos(radians) * span / 2, dy = sin(radians) * span / 2
        return (DevicePoint(x: centre.x - dx, y: centre.y - dy), DevicePoint(x: centre.x + dx, y: centre.y + dy))
    }

    private static func lerp(_ a: DevicePoint, _ b: DevicePoint, _ t: Double) -> DevicePoint {
        DevicePoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }
}

/// How `text` goes in: keys when every character has a US key and the text is short, else the
/// pasteboard and Cmd+V (stage 0: HID landed only the ASCII letters of "zażółć gęślą jaźń"; the
/// paste landed it whole).
enum TextRoute: Equatable {
    case keys, paste

    static func choose(_ text: String, via: HIDAction.TextVia) -> Result<TextRoute, HelperError> {
        let typable = KeyboardUsage.typable(text)
        let route: TextRoute
        switch via {
        case .paste: route = .paste
        // Long text pastes too: keys cost about 30 ms a character.
        case .auto: route = typable && text.count <= HIDLimits.keysTextMaxChars ? .keys : .paste
        case .keys:
            guard typable else {
                let first = text.first { KeyboardUsage.usage(for: $0) == nil }.map(String.init) ?? "?"
                return .failure(HelperError(.badParams, "\"\(first)\" has no key on a US keyboard: send via paste or auto"))
            }
            route = .keys
        }
        let count = text.count
        switch route {
        case .keys where count > HIDLimits.keysTextMaxChars:
            return .failure(HelperError(.badParams, "\(count) characters: type at most \(HIDLimits.keysTextMaxChars) per hid call through keys, or send via paste"))
        case .paste where text.utf16.count > HIDLimits.pasteTextMaxChars:
            return .failure(HelperError(.badParams, "paste at most \(HIDLimits.pasteTextMaxChars) characters per call"))
        default:
            return .success(route)
        }
    }
}
