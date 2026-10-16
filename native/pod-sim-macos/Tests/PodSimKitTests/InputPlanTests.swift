import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

/// iPhone 16 Pro: 1206x2622 pixels at scale 3.
private let screen = CGSize(width: 402, height: 874)

private func contacts(_ steps: [HIDStep]) -> [DigitizerContact] {
    steps.compactMap { if case .send(.digitizer(let contact)) = $0 { contact } else { nil } }
}

private func keys(_ steps: [HIDStep]) -> [(UInt16, HIDButtonState)] {
    steps.compactMap { if case .send(.key(let usage, let state)) = $0 { (usage, state) } else { nil } }
}

private func decode(_ json: String) -> Result<HIDAction, HelperError> {
    guard let wire = try? JSONDecoder().decode(HIDParams.WireAction.self, from: Data(json.utf8)) else {
        return .failure(HelperError(.badParams, "undecodable"))
    }
    return HIDAction.from(wire)
}

@Suite("Input plan")
struct InputPlanTests {
    @Test("device points become DTUHID's 0 to 1 screen ratio: the middle is (0.5, 0.5), the Start tab's centre stays its centre")
    func pointsToRatio() {
        let middle = contacts(HIDPlan.steps(.tap(DevicePoint(x: 201, y: 437), holdMs: 60), screen: screen))
        #expect(middle.first?.first == NormalizedPoint(x: 0.5, y: 0.5))
        let start = contacts(HIDPlan.steps(.tap(DevicePoint(x: 53, y: 817), holdMs: 60), screen: screen))
        #expect(start.first?.first == NormalizedPoint(x: 53.0 / 402, y: 817.0 / 874))
    }

    @Test("a point off the screen is refused before anything is sent, not clamped to the edge")
    func outsideRefused() {
        #expect(HIDPlan.outside(.tap(DevicePoint(x: 403, y: 10), holdMs: 60), screen: screen) == DevicePoint(x: 403, y: 10))
        #expect(HIDPlan.outside(.swipe(from: DevicePoint(x: 10, y: 10), to: DevicePoint(x: 10, y: -1), durationMs: 300, edge: nil), screen: screen) != nil)
        #expect(HIDPlan.outside(.tap(DevicePoint(x: 402, y: 874), holdMs: 60), screen: screen) == nil)
        #expect(HIDPlan.outside(.pinch(centre: DevicePoint(x: 201, y: 437), fromSpan: 80, toSpan: 500, durationMs: 400, angle: 0), screen: screen) != nil)
    }

    @Test("a tap is a start, a hold and an end at the same point; a long press holds longer")
    func tapShape() {
        let steps = HIDPlan.steps(.tap(DevicePoint(x: 100, y: 200), holdMs: 60), screen: screen)
        #expect(contacts(steps).map(\.phase) == [.start, .end])
        #expect(steps[1] == .wait(ms: 60))
        #expect(HIDPlan.plannedMs(HIDPlan.steps(.longPress(DevicePoint(x: 100, y: 200), durationMs: 1_000), screen: screen)) == 1_000)
    }

    @Test("a swipe samples about every 16 ms, ends held at its target and flags every contact of an edge swipe")
    func swipeShape() {
        let from = DevicePoint(x: 201, y: 873), to = DevicePoint(x: 201, y: 437)
        let steps = HIDPlan.steps(.swipe(from: from, to: to, durationMs: 320, edge: .bottom), screen: screen)
        let touched = contacts(steps)
        #expect(touched.first?.phase == .start)
        #expect(touched.last?.phase == .end)
        #expect(touched.count == 20 + 3)
        #expect(touched.allSatisfy { $0.edge == .bottom })
        #expect(touched[touched.count - 2].phase == .position)
        #expect(touched[touched.count - 2].first == touched.last?.first)
        #expect(touched.last?.first == NormalizedPoint(x: 0.5, y: 0.5))
        #expect(abs(HIDPlan.plannedMs(steps) - 320) < 0.001)
        #expect(contacts(HIDPlan.steps(.swipe(from: from, to: to, durationMs: 300, edge: nil), screen: screen)).allSatisfy { $0.edge == .none })
    }

    @Test("a drag holds before moving (an iOS drag starts past the long press) and settles before lifting")
    func dragShape() {
        let steps = HIDPlan.steps(.drag(from: DevicePoint(x: 50, y: 50), to: DevicePoint(x: 300, y: 50), pressMs: 600, durationMs: 160, releaseMs: 200), screen: screen)
        #expect(steps[1] == .wait(ms: 600))
        #expect(steps[steps.count - 2] == .wait(ms: 200))
        #expect(abs(HIDPlan.plannedMs(steps) - 960) < 0.001)
    }

    @Test("a pinch moves two contacts mirrored about the centre from one span to the other")
    func pinchShape() {
        let steps = HIDPlan.steps(.pinch(centre: DevicePoint(x: 201, y: 437), fromSpan: 80, toSpan: 272, durationMs: 192, angle: 0), screen: screen)
        let touched = contacts(steps)
        #expect(touched.allSatisfy { $0.second != nil })
        #expect(touched.first?.first == NormalizedPoint(x: 161.0 / 402, y: 0.5))
        #expect(touched.first?.second == NormalizedPoint(x: 241.0 / 402, y: 0.5))
        #expect(touched.last?.phase == .end)
        #expect(touched.last?.first == NormalizedPoint(x: 65.0 / 402, y: 0.5))
        #expect(touched.last?.second == NormalizedPoint(x: 337.0 / 402, y: 0.5))
    }

    @Test("raw touch phases map one to one, for a person's pointer")
    func rawTouch() {
        let down = contacts(HIDPlan.steps(.touch(phase: .down, points: [DevicePoint(x: 1, y: 437)], edge: .left), screen: screen))
        #expect(down.map(\.phase) == [.start])
        #expect(down.first?.edge == .left)
        #expect(contacts(HIDPlan.steps(.touch(phase: .move, points: [DevicePoint(x: 2, y: 2)], edge: nil), screen: screen)).map(\.phase) == [.position])
        #expect(contacts(HIDPlan.steps(.touch(phase: .up, points: [DevicePoint(x: 2, y: 2)], edge: nil), screen: screen)).map(\.phase) == [.end])
    }

    @Test("every printable ASCII character, newline and tab has a US key; Polish letters and accents do not")
    func usTable() {
        let printable = (0x20...0x7E).map { Character(UnicodeScalar($0)!) }
        #expect(printable.allSatisfy { KeyboardUsage.usage(for: $0) != nil })
        #expect(KeyboardUsage.usage(for: "a")! == (0x04, false))
        #expect(KeyboardUsage.usage(for: "Z")! == (0x1D, true))
        #expect(KeyboardUsage.usage(for: "0")! == (0x27, false))
        #expect(KeyboardUsage.usage(for: "@")! == (0x1F, true))
        #expect(KeyboardUsage.usage(for: "\n")! == (0x28, false))
        for character: Character in ["ą", "ż", "é", "ł", "€", "\u{1F600}"] {
            #expect(KeyboardUsage.usage(for: character) == nil)
        }
    }

    @Test("typing holds shift only around the characters that need it")
    func typingShift() {
        let typed = keys(HIDPlan.typing("aB"))
        #expect(typed.map(\.0) == [0x04, 0x04, KeyboardUsage.leftShift, 0x05, 0x05, KeyboardUsage.leftShift])
        #expect(typed.map(\.1) == [.down, .up, .down, .down, .up, .up])
    }

    @Test("text goes as keys when short ASCII, through the pasteboard otherwise; keys are refused for what has no key")
    func textRoutes() throws {
        #expect(try TextRoute.choose("you@email.com", via: .auto).get() == .keys)
        #expect(try TextRoute.choose("zażółć gęślą jaźń", via: .auto).get() == .paste)
        #expect(try TextRoute.choose(String(repeating: "a", count: 251), via: .auto).get() == .paste)
        #expect(try TextRoute.choose("plain", via: .paste).get() == .paste)
        if case .failure(let error) = TextRoute.choose("zażółć", via: .keys) {
            #expect(error.code == .badParams)
            #expect(error.message.contains("ż"))
        } else {
            Issue.record("keys accepted text with no US keys")
        }
        if case .success = TextRoute.choose(String(repeating: "a", count: 251), via: .keys) { Issue.record("keys over the limit accepted") }
        if case .success = TextRoute.choose(String(repeating: "ą", count: 4097), via: .auto) { Issue.record("paste over the limit accepted") }
    }

    @Test("a key holds its modifiers around it and lets go in reverse; Cmd+V is the paste")
    func keyCombos() {
        let pressed = keys(HIDPlan.steps(.key(usage: 0x28, modifiers: ["command", "shift"], phase: .press), screen: screen))
        #expect(pressed.map(\.0) == [KeyboardUsage.leftCommand, KeyboardUsage.leftShift, 0x28, 0x28, KeyboardUsage.leftShift, KeyboardUsage.leftCommand])
        #expect(pressed.map(\.1) == [.down, .down, .down, .up, .up, .up])
        #expect(keys(HIDPlan.paste).map(\.0) == [KeyboardUsage.leftCommand, KeyboardUsage.v, KeyboardUsage.v, KeyboardUsage.leftCommand])
        #expect(keys(HIDPlan.steps(.key(usage: 0x52, modifiers: [], phase: .down), screen: screen)).map(\.1) == [.down])
    }

    @Test("hardware buttons are consumer-page usages, held and released")
    func buttons() {
        let steps = HIDPlan.steps(.button(.home, holdMs: 100), screen: screen)
        #expect(steps == [.send(.button(page: 0x0C, usage: 0x40, state: .down)), .wait(ms: 100), .send(.button(page: 0x0C, usage: 0x40, state: .up))])
        #expect(HIDButton.lock.usage == (0x0C, 0x30))
        #expect(HIDButton.volumeUp.usage == (0x0C, 0xE9))
        #expect(HIDButton.volumeDown.usage == (0x0C, 0xEA))
        #expect(HIDButton.siri.usage == (0x0C, 0xCF))
    }

    @Test("actions decode with defaults and refuse what is out of bounds")
    func decoding() throws {
        #expect(try decode(#"{"kind":"tap","x":10,"y":20}"#).get() == .tap(DevicePoint(x: 10, y: 20), holdMs: 60))
        #expect(try decode(#"{"kind":"swipe","from":{"x":1,"y":2},"to":{"x":3,"y":4}}"#).get()
            == .swipe(from: DevicePoint(x: 1, y: 2), to: DevicePoint(x: 3, y: 4), durationMs: 300, edge: nil))
        #expect(try decode(#"{"kind":"key","key":"A"}"#).get() == .key(usage: 0x04, modifiers: ["shift"], phase: .press))
        #expect(try decode(#"{"kind":"key","key":"return","modifiers":["command"]}"#).get() == .key(usage: 0x28, modifiers: ["command"], phase: .press))
        #expect(try decode(#"{"kind":"text","text":"hi"}"#).get() == .text("hi", via: .auto))
        #expect(try decode(#"{"kind":"button","button":"lock"}"#).get() == .button(.lock, holdMs: 100))
        for refused in [
            #"{"kind":"tap","x":10}"#, #"{"kind":"tap","x":10,"y":20,"holdMs":0}"#,
            #"{"kind":"swipe","from":{"x":1,"y":2},"to":{"x":3,"y":4},"durationMs":6000}"#,
            #"{"kind":"touch","phase":"down","points":[{"x":1,"y":1},{"x":2,"y":2},{"x":3,"y":3}]}"#,
            #"{"kind":"key","key":"ą"}"#, #"{"kind":"key","key":"return","modifiers":["hyper"]}"#,
            #"{"kind":"text","text":""}"#, #"{"kind":"button","button":"camera"}"#, #"{"kind":"shake"}"#,
        ] {
            if case .success(let action) = decode(refused) { Issue.record("\(refused) decoded as \(action)") }
        }
    }

    @Test("simctl pbcopy reads UTF-8 whatever locale the helper started with (none from Finder, C, Latin-1)")
    func pasteboardLocale() {
        for base in [[:], ["LC_ALL": "C"], ["LANG": "pl_PL.ISO8859-2", "LC_ALL": "pl_PL.ISO8859-2"]] {
            let environment = Pasteboard.environment(base)
            #expect(environment["LC_ALL"] == "en_US.UTF-8")
        }
        #expect(Pasteboard.environment(["DEVELOPER_DIR": "/x"])["DEVELOPER_DIR"] == "/x")
    }
}
