import Foundation
import Testing
@testable import PodSimKit

/// Every answer the handler gave, by request id.
private final class Answers: @unchecked Sendable {
    private let lock = NSLock()
    private var byID: [Int: Reply] = [:]

    func sink(_ id: Int) -> @Sendable (Reply) -> Void {
        { reply in self.lock.withLock { self.byID[id] = reply } }
    }

    var count: Int { lock.withLock { byID.count } }

    func wait(for id: Int, seconds: Double = 5) -> Reply? {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            if let reply = lock.withLock({ byID[id] }) { return reply }
            usleep(2_000)
        } while Date() < end
        return nil
    }
}

private func code(_ reply: Reply?) -> HelperErrorCode? {
    if case .error(let error)? = reply { return error.code }
    return nil
}

/// The public fallback stands in for DTUHID (the table is forced unknown): it records the x of every
/// contact per device, and holds one device's calls until the test lets them go.
private final class RecordingDriver: PublicInputFallback, @unchecked Sendable {
    let stalled: String
    let gate = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var seen: [String: [Double]] = [:]

    init(stalled: String) {
        self.stalled = stalled
    }

    func xs(_ udid: String) -> [Double] { lock.withLock { seen[udid] ?? [] } }

    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
        if case .touch(_, let points, _) = action { lock.withLock { seen[udid, default: []].append(points[0].x) } }
        if udid == stalled { gate.wait() }
        return .success(HIDResult(udid: udid, kind: action.kind, ms: 0, via: nil, typed: nil, frameAfterMs: nil, degraded: nil))
    }
}

@Suite("Input lanes")
struct InputLanesTests {
    private static let deviceA = "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0"
    private static let deviceB = "01C2D240-07BE-4772-AB65-D00D78C451A0"

    private func touch(_ id: Int, _ udid: String, phase: String, x: Int) -> Request {
        Request(id: id, method: "hid", params: Data(#"{"udid":"\#(udid)","action":{"kind":"touch","phase":"\#(phase)","points":[{"x":\#(x),"y":100}]}}"#.utf8))
    }

    @Test("a device's hid calls run in the order they arrived; a full lane answers busy at once while another device is served")
    func orderBackpressureAndIsolation() {
        let driver = RecordingDriver(stalled: Self.deviceA)
        let methods = HelperMethods(
            environment: ["DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer", "POD_SIM_FORCE_UNKNOWN_BUILD": "1"],
            inputFallback: driver, accessibilityFallback: NoPublicAccessibilityFallback())
        let answers = Answers()
        // A pointer stream on A: down, moves, up, as stage 8 sends them without waiting for answers.
        let depth = InputLanes.maxDepth
        for index in 0..<depth {
            let phase = index == 0 ? "down" : index == depth - 1 ? "up" : "move"
            _ = methods.handle(touch(index, Self.deviceA, phase: phase, x: index), reply: answers.sink(index))
        }
        _ = methods.handle(touch(100, Self.deviceA, phase: "move", x: 100), reply: answers.sink(100))
        #expect(code(answers.wait(for: 100, seconds: 1)) == .busy)

        _ = methods.handle(touch(200, Self.deviceB, phase: "down", x: 7), reply: answers.sink(200))
        guard case .result? = answers.wait(for: 200) else {
            Issue.record("device B waited on device A's stalled lane")
            return
        }
        #expect(answers.count == 2)

        for _ in 0..<depth { driver.gate.signal() }
        for index in 0..<depth {
            guard case .result? = answers.wait(for: index) else {
                Issue.record("call \(index) on A got no result")
                return
            }
        }
        #expect(driver.xs(Self.deviceA) == (0..<depth).map(Double.init))
        #expect(driver.xs(Self.deviceB) == [7])
    }

    @Test("a call whose deadline passed while it waited in the lane is answered timeout and never sent")
    func lateCallNeverRuns() {
        let lanes = InputLanes(maxDepth: 4)
        let dispatcher = DeadlineDispatcher()
        let answers = Answers()
        let hold = DispatchSemaphore(value: 0)
        let ran = Answers()
        lanes.submit(udid: Self.deviceA, call: dispatcher.start("hid", deadlineMs: 5_000, reply: answers.sink(1))) {
            hold.wait()
            ran.sink(1)(.result(Data("{}".utf8)))
            return .result(Data("{}".utf8))
        }
        lanes.submit(udid: Self.deviceA, call: dispatcher.start("hid", deadlineMs: 50, reply: answers.sink(2))) {
            ran.sink(2)(.result(Data("{}".utf8)))
            return .result(Data("{}".utf8))
        }
        #expect(code(answers.wait(for: 2, seconds: 2)) == .timeout)
        hold.signal()
        lanes.submit(udid: Self.deviceA, call: dispatcher.start("hid", deadlineMs: 5_000, reply: answers.sink(3))) {
            ran.sink(3)(.result(Data("{}".utf8)))
            return .result(Data("{}".utf8))
        }
        #expect(answers.wait(for: 3) != nil)
        #expect(ran.wait(for: 1, seconds: 0) != nil)
        #expect(ran.wait(for: 2, seconds: 0.2) == nil)
    }
}
