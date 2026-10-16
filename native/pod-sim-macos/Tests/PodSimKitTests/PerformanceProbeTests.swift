import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

/// Measurements, not checks, skipped unless asked for (release: `swift test -c release -Xswiftc
/// -enable-testing --filter PerformanceProbeTests`):
/// - `POD_SIM_BENCH=1`: what the device lane adds to a `hid` call, against the concurrent queue it replaced.
/// - `POD_SIM_PROBE_UDID=<udid>` with `POD_SIM_DEVICE_SET=<set>`: `ax` per phase on a booted device,
///   whatever app is frontmost; `POD_SIM_PROBE_FILTER` adds a filtered run.
@Suite("Performance probes")
struct PerformanceProbeTests {
    private static let environment = ProcessInfo.processInfo.environment

    private static func percentiles(_ samples: [Double]) -> String {
        let sorted = samples.sorted()
        func at(_ p: Double) -> Double { sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        return String(format: "n %d p50 %.1f p95 %.1f p99 %.1f max %.1f", sorted.count, at(0.5), at(0.95), at(0.99), sorted.last ?? 0)
    }

    private final class Entered: PublicInputFallback, @unchecked Sendable {
        private let lock = NSLock()
        private var at: UInt64 = 0
        let done = DispatchSemaphore(value: 0)
        var entered: UInt64 { lock.withLock { at } }
        func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
            lock.withLock { at = DispatchTime.now().uptimeNanoseconds }
            return .success(HIDResult(udid: udid, kind: action.kind, ms: 0, via: nil, typed: nil, frameAfterMs: nil, degraded: nil))
        }
    }

    @Test("the hid lane's added cost per call", .enabled(if: environment["POD_SIM_BENCH"] == "1"))
    func laneHop() {
        let driver = Entered()
        let methods = HelperMethods(
            environment: ["DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer", "POD_SIM_FORCE_UNKNOWN_BUILD": "1"],
            inputFallback: driver, accessibilityFallback: NoPublicAccessibilityFallback())
        let concurrent = DeadlineDispatcher()
        let params = Data(#"{"udid":"8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0","action":{"kind":"touch","phase":"move","points":[{"x":10,"y":20}]}}"#.utf8)
        var lane: [Double] = [], replaced: [Double] = []
        for round in 0..<40_000 {
            let answered = DispatchSemaphore(value: 0)
            let start = DispatchTime.now().uptimeNanoseconds
            if round % 2 == 0 {
                _ = methods.handle(Request(id: round, method: "hid", params: params)) { _ in answered.signal() }
            } else {
                // Before this round: every method on the concurrent work queue, decoded there.
                concurrent.run("hid", deadlineMs: 15_000, { methods.hid(params) }, reply: { _ in answered.signal() })
            }
            answered.wait()
            let micros = Double(driver.entered - start) / 1_000
            if round >= 2_000 { (round % 2 == 0 ? { lane.append(micros) } : { replaced.append(micros) })() }
        }
        print("hid lane: request to work start, µs: \(Self.percentiles(lane))")
        print("concurrent queue (before): request to work start, µs: \(Self.percentiles(replaced))")
    }

    @Test("a fresh connection's first tap lands", .enabled(if: environment["POD_SIM_PROBE_TAP_LABEL"] != nil))
    func coldFirstTap() throws {
        let udid = try #require(Self.environment["POD_SIM_PROBE_UDID"]).uppercased()
        let label = try #require(Self.environment["POD_SIM_PROBE_TAP_LABEL"])
        let methods = HelperMethods(environment: Self.environment)
        let device = try methods.helperContext.simulatorService.flatMap { $0.device(udid: udid) }.get()
        let before = try AccessibilitySnapshots.take(device, options: AXSnapshotOptions(filter: label), hitTest: true).get()
        let target = try #require(before.nodes.first { $0.label == label && $0.visible })
        // The first hid of this process: it connects, waits the reply tail once, then taps.
        let started = DispatchTime.now().uptimeNanoseconds
        let reply = methods.hid(Data(#"{"udid":"\#(udid)","action":{"kind":"tap","x":\#(target.centre.x),"y":\#(target.centre.y)}}"#.utf8))
        let callMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        guard case .result = reply else { throw HelperError(.failed, "the cold tap answered \(reply)") }
        var appAfter: Int?
        for _ in 0..<30 where appAfter == nil || appAfter == before.app?.pid {
            Thread.sleep(forTimeInterval: 0.1)
            appAfter = try? AccessibilitySnapshots.take(device, options: AXSnapshotOptions(maxNodes: 1), hitTest: false).get().app?.pid
        }
        print("cold tap on \(label) at (\(target.centre.x), \(target.centre.y)): call \(String(format: "%.1f", callMs)) ms, frontmost pid \(before.app?.pid ?? -1) -> \(appAfter ?? -1)")
        #expect(appAfter != nil && appAfter != before.app?.pid)
        // A second call on the same connection pays no tail.
        let warmStarted = DispatchTime.now().uptimeNanoseconds
        _ = methods.hid(Data(#"{"udid":"\#(udid)","action":{"kind":"key","key":"a","phase":"up"}}"#.utf8))
        print("warm call on the same connection: \(String(format: "%.1f", Double(DispatchTime.now().uptimeNanoseconds - warmStarted) / 1_000_000)) ms")
    }

    @Test("ax per phase on a booted device", .enabled(if: environment["POD_SIM_PROBE_UDID"] != nil))
    func axPhases() throws {
        let udid = try #require(Self.environment["POD_SIM_PROBE_UDID"]).uppercased()
        let context = HelperContext.discover(environment: Self.environment)
        let device = try context.simulatorService.flatMap { $0.device(udid: udid) }.get()
        var runs: [(String, AXSnapshotOptions, Bool)] = [
            ("hit tests", AXSnapshotOptions(), true), ("no hit tests", AXSnapshotOptions(), false),
        ]
        if let filter = Self.environment["POD_SIM_PROBE_FILTER"] {
            runs.append(("filter \(filter), hit tests", AXSnapshotOptions(filter: filter), true))
        }
        _ = AccessibilitySnapshots.timed(device, options: AXSnapshotOptions(), hitTest: true)
        for (name, options, hitTest) in runs {
            var total: [Double] = [], frontmost: [Double] = [], attributes: [Double] = [], hits: [Double] = []
            var last: (result: AXSnapshotResult, timings: AXWalkTimings, requests: Int, transportMs: Double)?
            var transport: [Double] = []
            for _ in 0..<30 {
                let started = DispatchTime.now().uptimeNanoseconds
                let taken = try AccessibilitySnapshots.timed(device, options: options, hitTest: hitTest).get()
                total.append(Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
                frontmost.append(taken.timings.frontmostMs)
                attributes.append(taken.timings.attributesMs)
                hits.append(taken.timings.hitTestsMs)
                transport.append(taken.transportMs)
                last = taken
            }
            let shape = last.map { "\($0.timings.attributeCalls) elements, \($0.timings.hitTests) hit tests, \($0.requests) device requests, \($0.result.shown) shown" } ?? ""
            print("ax [\(name)] \(shape)")
            print("  total ms: \(Self.percentiles(total))")
            print("  frontmost ms: \(Self.percentiles(frontmost))")
            print("  attributes ms: \(Self.percentiles(attributes))")
            print("  hit tests ms: \(Self.percentiles(hits))")
            print("  waiting on the device ms: \(Self.percentiles(transport))")
        }
    }
}
