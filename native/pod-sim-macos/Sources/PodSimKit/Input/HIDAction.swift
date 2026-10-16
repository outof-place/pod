import CoreGraphics
import Foundation

/// A point in device points, origin top-left: the accessibility frames' space.
public struct DevicePoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum HIDEdge: String, Codable, Sendable {
    case left, right, top, bottom
}

/// What `hid` does, in device points and milliseconds. Gestures (`tap` to `pinch`) are timed by the
/// helper; `touch` is one raw contact phase for a person's pointer (stage 8's takeover streams these).
public enum HIDAction: Equatable, Sendable {
    case tap(DevicePoint, holdMs: Int)
    case longPress(DevicePoint, durationMs: Int)
    case swipe(from: DevicePoint, to: DevicePoint, durationMs: Int, edge: HIDEdge?)
    /// Press and hold (an iOS drag session starts past the long-press threshold), travel, settle, lift.
    case drag(from: DevicePoint, to: DevicePoint, pressMs: Int, durationMs: Int, releaseMs: Int)
    /// Two contacts mirrored about `centre` along `angle` degrees, `fromSpan` to `toSpan` points apart.
    case pinch(centre: DevicePoint, fromSpan: Double, toSpan: Double, durationMs: Int, angle: Double)
    case touch(phase: TouchPhase, points: [DevicePoint], edge: HIDEdge?)
    case text(String, via: TextVia)
    /// A keyboard usage (page 7) with modifier names held around it.
    case key(usage: UInt16, modifiers: [String], phase: KeyPhase)
    case button(HIDButton, holdMs: Int)

    public enum TouchPhase: String, Codable, Sendable { case down, move, up }
    public enum TextVia: String, Codable, Sendable { case auto, keys, paste }
    public enum KeyPhase: String, Codable, Sendable { case press, down, up }

    public var kind: String {
        switch self {
        case .tap: "tap"
        case .longPress: "longPress"
        case .swipe: "swipe"
        case .drag: "drag"
        case .pinch: "pinch"
        case .touch: "touch"
        case .text: "text"
        case .key: "key"
        case .button: "button"
        }
    }
}

/// Hardware buttons as DTUHID's `IndigoButtonEvent` names them: HID consumer page (0x0C) usages
/// (idb v1.7.2 `SimulatorHIDButtonIdentity`).
public enum HIDButton: String, Codable, Sendable, CaseIterable {
    case home, lock, siri, volumeUp, volumeDown

    var usage: (page: UInt16, code: UInt16) {
        switch self {
        case .home: (0x0C, 0x40) // Menu
        case .lock: (0x0C, 0x30) // Power
        case .siri: (0x0C, 0xCF) // Voice Command
        case .volumeUp: (0x0C, 0xE9)
        case .volumeDown: (0x0C, 0xEA)
        }
    }
}

/// Bounds every `hid` action is checked against before anything is sent.
public enum HIDLimits {
    /// Keys typed one by one at about 30 ms a character fit `hid`'s deadline at this length; longer
    /// text is split by the caller or pasted.
    public static let keysTextMaxChars = 250
    /// The frozen contract's `SIM_TYPE_MAX_CHARS`.
    public static let pasteTextMaxChars = 4096
    /// No action may plan more time than this: `hid`'s deadline covers it plus connecting.
    public static let plannedMaxMs = 10_000
}

/// `hid`'s params as they arrive on the wire.
struct HIDParams: Decodable {
    let udid: String
    let action: WireAction
    /// Report how long after the first event the screen produced its first frame, waiting at most this.
    let waitForFrameMs: Int?

    struct WireAction: Decodable {
        let kind: String
        let x: Double?
        let y: Double?
        let holdMs: Int?
        let durationMs: Int?
        let from: DevicePoint?
        let to: DevicePoint?
        let edge: HIDEdge?
        let pressMs: Int?
        let releaseMs: Int?
        let centre: DevicePoint?
        let fromSpan: Double?
        let toSpan: Double?
        let angle: Double?
        let phase: String?
        let points: [DevicePoint]?
        let text: String?
        let via: HIDAction.TextVia?
        let key: String?
        let usage: Int?
        let modifiers: [String]?
        let button: HIDButton?
    }
}

extension HIDAction {
    /// The action with defaults filled in, or why it is refused (`badParams`).
    static func from(_ wire: HIDParams.WireAction) -> Result<HIDAction, HelperError> {
        func point() -> Result<DevicePoint, HelperError> {
            guard let x = wire.x, let y = wire.y else { return .failure(bad("\(wire.kind) needs x and y")) }
            return .success(DevicePoint(x: x, y: y))
        }
        func required(_ value: DevicePoint?, _ name: String) -> Result<DevicePoint, HelperError> {
            value.map { .success($0) } ?? .failure(bad("\(wire.kind) needs \(name)"))
        }
        func ms(_ value: Int?, _ name: String, default fallback: Int, _ range: ClosedRange<Int>) -> Result<Int, HelperError> {
            let chosen = value ?? fallback
            return range.contains(chosen) ? .success(chosen) : .failure(bad("\(name) must be \(range.lowerBound) to \(range.upperBound) ms"))
        }
        switch wire.kind {
        case "tap":
            return point().flatMap { at in ms(wire.holdMs, "holdMs", default: 60, 1...5_000).map { .tap(at, holdMs: $0) } }
        case "longPress":
            return point().flatMap { at in ms(wire.durationMs, "durationMs", default: 1_000, 300...5_000).map { .longPress(at, durationMs: $0) } }
        case "swipe":
            return required(wire.from, "from").flatMap { from in
                required(wire.to, "to").flatMap { to in
                    ms(wire.durationMs, "durationMs", default: 300, 50...5_000).map { .swipe(from: from, to: to, durationMs: $0, edge: wire.edge) }
                }
            }
        case "drag":
            return required(wire.from, "from").flatMap { from in
                required(wire.to, "to").flatMap { to in
                    ms(wire.pressMs, "pressMs", default: 600, 0...3_000).flatMap { press in
                        ms(wire.durationMs, "durationMs", default: 500, 50...5_000).flatMap { travel in
                            ms(wire.releaseMs, "releaseMs", default: 200, 0...2_000).map { release in
                                .drag(from: from, to: to, pressMs: press, durationMs: travel, releaseMs: release)
                            }
                        }
                    }
                }
            }
        case "pinch":
            return required(wire.centre, "centre").flatMap { centre in
                guard let fromSpan = wire.fromSpan, let toSpan = wire.toSpan, fromSpan >= 1, toSpan >= 1, fromSpan <= 4_000, toSpan <= 4_000 else {
                    return .failure(bad("pinch needs fromSpan and toSpan of 1 to 4000 points"))
                }
                return ms(wire.durationMs, "durationMs", default: 400, 50...5_000).map {
                    .pinch(centre: centre, fromSpan: fromSpan, toSpan: toSpan, durationMs: $0, angle: wire.angle ?? 0)
                }
            }
        case "touch":
            guard let phase = wire.phase.flatMap(TouchPhase.init(rawValue:)) else { return .failure(bad("touch needs phase down, move or up")) }
            guard let points = wire.points, (1...2).contains(points.count) else { return .failure(bad("touch needs one or two points")) }
            return .success(.touch(phase: phase, points: points, edge: wire.edge))
        case "text":
            guard let text = wire.text, !text.isEmpty else { return .failure(bad("text needs text")) }
            return .success(.text(text, via: wire.via ?? .auto))
        case "key":
            let modifiers = wire.modifiers ?? []
            if let unknown = modifiers.first(where: { KeyboardUsage.modifiers[$0] == nil }) {
                return .failure(bad("no modifier \(unknown) (shift, control, option, command)"))
            }
            guard let phase = KeyPhase(rawValue: wire.phase ?? "press") else { return .failure(bad("key phase must be press, down or up")) }
            if let usage = wire.usage {
                guard (1...0xFFFF).contains(usage) else { return .failure(bad("usage must be a HID keyboard usage")) }
                return .success(.key(usage: UInt16(usage), modifiers: modifiers, phase: phase))
            }
            guard let key = wire.key else { return .failure(bad("key needs key or usage")) }
            if let usage = KeyboardUsage.named[key] {
                return .success(.key(usage: usage, modifiers: modifiers, phase: phase))
            }
            // One printable ASCII character: its US key, with shift when the character needs it.
            guard key.count == 1, let character = key.first, let found = KeyboardUsage.usage(for: character), character != "\n", character != "\t" else {
                return .failure(bad("no key \(key): a named key or one printable ASCII character"))
            }
            let withShift = found.shift && !modifiers.contains("shift") ? modifiers + ["shift"] : modifiers
            return .success(.key(usage: found.usage, modifiers: withShift, phase: phase))
        case "button":
            guard let button = wire.button else { return .failure(bad("button needs one of \(HIDButton.allCases.map(\.rawValue).joined(separator: ", "))")) }
            return ms(wire.holdMs, "holdMs", default: 100, 1...5_000).map { .button(button, holdMs: $0) }
        default:
            return .failure(bad("no hid action \(wire.kind)"))
        }
    }

    private static func bad(_ message: String) -> HelperError {
        HelperError(.badParams, message)
    }
}
