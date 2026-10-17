import CPodSimSurface
import CoreGraphics
import Foundation
import IOSurface
import Testing
@testable import PodSimKit

/// Measurements, not checks, skipped unless asked for (release: `swift test -c release -Xswiftc
/// -enable-testing --filter PerformanceProbeTests`):
/// - `POD_SIM_BENCH=1`: what the device lane adds to a `hid` call, against the concurrent queue it replaced.
/// - `POD_SIM_PROBE_UDID=<udid>` with `POD_SIM_DEVICE_SET=<set>`: `ax` per phase on a booted device,
///   whatever app is frontmost; `POD_SIM_PROBE_FILTER` adds a filtered run; `POD_SIM_PROBE_SHOTS=1`
///   times a screenshot's phases (the remote surface read, the copy, the PNG and JPEG encodes, the
///   write) and a settle hash on whatever the device shows.
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

    @Test("a screenshot's phases on a booted device", .enabled(if: environment["POD_SIM_PROBE_SHOTS"] == "1"))
    func screenshotPhases() throws {
        let udid = try #require(Self.environment["POD_SIM_PROBE_UDID"]).uppercased()
        let methods = HelperMethods(environment: Self.environment)
        let device = try methods.helperContext.simulatorService.flatMap { $0.device(udid: udid) }.get()
        let port = try DisplayPort.main(of: device).get()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-probe-\(getpid())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var remote: [Double] = [], copy: [Double] = [], png: [Double] = [], write: [Double] = [], jpeg: [Double] = [], hash: [Double] = []
        let writer = ImageWriter()
        func ms(_ since: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - since) / 1_000_000 }
        var bytes = 0
        for round in 0..<30 {
            var started = DispatchTime.now().uptimeNanoseconds
            let surface = try #require(port.surface())
            remote.append(ms(started))
            started = DispatchTime.now().uptimeNanoseconds
            let pixels = try #require(PixelCopy.of(surface))
            copy.append(ms(started))
            started = DispatchTime.now().uptimeNanoseconds
            var out: UnsafeMutablePointer<UInt8>?
            var size = 0
            #expect(pod_sim_png_encode(pixels.pixels.assumingMemoryBound(to: UInt8.self), pixels.width, pixels.height, pixels.stride, &out, &size) == 0)
            png.append(ms(started))
            bytes = size
            started = DispatchTime.now().uptimeNanoseconds
            try Data(bytesNoCopy: try #require(out), count: size, deallocator: .free).write(to: directory.appendingPathComponent("\(round).png"))
            write.append(ms(started))
            started = DispatchTime.now().uptimeNanoseconds
            _ = writer.write(surface: surface, to: directory.appendingPathComponent("\(round).jpg").path, ImageOptions(format: .jpeg, scale: 1, quality: 0.8))
            jpeg.append(ms(started))
            let grid = TileGrid(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface))
            var hashes = [UInt64](repeating: 0, count: grid.count)
            var before: UInt32 = 0, after: UInt32 = 0
            started = DispatchTime.now().uptimeNanoseconds
            _ = hashes.withUnsafeMutableBufferPointer {
                pod_sim_tile_hashes(Unmanaged.passUnretained(surface).toOpaque(), UInt32(grid.tile), $0.baseAddress, $0.count, &before, &after)
            }
            hash.append(ms(started))
        }
        print("screenshot phases, ms (PNG \(bytes / 1024) KB):")
        print("  remote framebufferSurface \(Self.percentiles(remote))")
        print("  seed-stable copy          \(Self.percentiles(copy))")
        print("  PNG encode                \(Self.percentiles(png))")
        print("  PNG write                 \(Self.percentiles(write))")
        print("  JPEG (copy+encode+write)  \(Self.percentiles(jpeg))")
        print("  settle tile hash          \(Self.percentiles(hash))")
    }

    /// The old-style damage callback (idb v1.7.2 SimDisplayRenderable-Protocol.h says it delivers an
    /// empty array on modern CoreSimulator): whether it carries any geometry here.
    @Test("damage rectangles from CoreSimulator", .enabled(if: environment["POD_SIM_PROBE_DAMAGE"] == "1"))
    func damageRectangles() throws {
        let udid = try #require(Self.environment["POD_SIM_PROBE_UDID"]).uppercased()
        let methods = HelperMethods(environment: Self.environment)
        let device = try methods.helperContext.simulatorService.flatMap { $0.device(udid: udid) }.get()
        let port = try DisplayPort.main(of: device).get()
        let selector = NSSelectorFromString("registerCallbackWithUUID:damageRectanglesCallback:")
        print("descriptor responds to the damage callback: \(port.descriptor.responds(to: selector))")
        let counts = DamageCounts()
        let token = UUID()
        let registered = ObjCGuard.attempt("damageRectanglesCallback") {
            (port.descriptor as AnyObject).registerDamageCallback(uuid: token) { rects in counts.add(rects) }
        }
        print("register: \(registered)")
        Thread.sleep(forTimeInterval: 3)
        _ = ObjCGuard.attempt("unregisterDamage") { (port.descriptor as AnyObject).unregisterDamageCallback(uuid: token) }
        print("damage callbacks in 3 s: \(counts.summary)")
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

@objc private protocol PodSimDamageCallbacks {
    @objc(registerCallbackWithUUID:damageRectanglesCallback:)
    func registerDamageCallback(uuid: UUID, callback: @escaping (Any?) -> Void)
    @objc(unregisterDamageRectanglesCallbackWithUUID:)
    func unregisterDamageCallback(uuid: UUID)
}

private final class DamageCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private var rects = 0
    private var sample = ""

    func add(_ value: Any?) {
        lock.withLock {
            calls += 1
            let array = value as? [Any] ?? []
            rects += array.count
            if sample.isEmpty, let first = array.first { sample = "\(first)" }
        }
    }

    var summary: String { lock.withLock { "\(calls) calls, \(rects) rectangles, first \(sample.isEmpty ? "none" : sample)" } }
}
