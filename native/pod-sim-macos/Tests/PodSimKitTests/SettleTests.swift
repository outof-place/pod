import Foundation
import IOSurface
import Testing
@testable import PodSimKit

@Suite("Damage map")
struct DamageMapTests {
    // 100 x 60 px in 16 px tiles: 7 x 4 tiles, the last column 4 px wide and the last row 12 px tall.
    private let grid = TileGrid(width: 100, height: 60, tile: 16)

    private func bits(_ tiles: [(Int, Int)]) -> TileBits {
        var bits = TileBits(count: grid.count)
        for (x, y) in tiles { bits.insert(y * grid.tilesX + x) }
        return bits
    }

    @Test("changed tiles are the ones whose hash differs")
    func changed() {
        var bits = TileBits(count: 4)
        DamageMap.changed(previous: [1, 2, 3, 4], current: [1, 9, 3, 8], into: &bits)
        #expect((0..<4).filter(bits.contains) == [1, 3])
    }

    @Test("diagonal neighbours join one region, a gap splits them, and the edge clips to the surface, largest first")
    func regions() {
        let found = DamageMap.regions(bits([(0, 0), (1, 1), (6, 3), (4, 0)]), grid: grid)
        #expect(found == [
            PixelRect(x: 0, y: 0, width: 32, height: 32),
            PixelRect(x: 64, y: 0, width: 16, height: 16),
            PixelRect(x: 96, y: 48, width: 4, height: 12),
        ])
        #expect(DamageMap.regions(TileBits(count: grid.count), grid: grid).isEmpty)
    }

    @Test("small regions (a caret, a spinner) are ignored, a large one blocks, and more than maxSmall small ones all block")
    func split() {
        let caret = PixelRect(x: 0, y: 0, width: 16, height: 112)
        let spinner = PixelRect(x: 200, y: 200, width: 112, height: 112)
        let banner = PixelRect(x: 0, y: 400, width: 1206, height: 160)
        #expect(DamageMap.split([banner, spinner, caret], scale: 3, smallPt: 48, maxSmall: 4)
            == MotionSplit(blocking: [banner], ignored: [spinner, caret]))
        let cells = (0..<5).map { PixelRect(x: 0, y: $0 * 200, width: 96, height: 48) }
        #expect(DamageMap.split(cells, scale: 3, smallPt: 48, maxSmall: 4) == MotionSplit(blocking: cells, ignored: []))
    }

    @Test("point rects cover their pixels in whole points")
    func pointRect() {
        let rect = PointRect(PixelRect(x: 16, y: 32, width: 16, height: 16), scale: 3)
        #expect([rect.x, rect.y, rect.width, rect.height] == [5, 10, 6, 6])
    }
}

/// A clock that moves only when settle waits or reads; motion is a script of (when, what moved).
private final class ScriptedSignals: SettleSignals {
    var clock: UInt64 = 60_000_000_000
    let watchesPixels: Bool
    var readsTree: Bool
    let knownSinceNs: UInt64
    /// Each frame of motion: its time and the regions it changed.
    var frames: [(atNs: UInt64, split: MotionSplit)] = []
    var tree: [TreeRead?]
    let readCostNs: UInt64 = 30_000_000
    private(set) var readsDone = 0

    init(pixels: Bool = true, tree: [TreeRead?], knownSinceMsAgo: Int = 0) {
        watchesPixels = pixels
        readsTree = !tree.isEmpty
        self.tree = tree
        knownSinceNs = clock - UInt64(knownSinceMsAgo) * 1_000_000
    }

    func now() -> UInt64 { clock }

    func motion(sinceNs: UInt64) -> MotionSplit {
        let moved = frames.filter { $0.atNs > sinceNs && $0.atNs <= clock }.map(\.split)
        return MotionSplit(blocking: Self.merged(moved.flatMap(\.blocking)), ignored: Self.merged(moved.flatMap(\.ignored)))
    }

    func waitForChange(untilNs: UInt64) {
        let next = frames.first { $0.atNs > clock }?.atNs ?? untilNs
        clock = max(clock, min(untilNs, next))
    }

    func readTree() -> TreeRead? {
        clock += readCostNs
        let read = tree[min(readsDone, tree.count - 1)]
        readsDone += 1
        return read
    }

    /// Every `everyMs` from `fromMs` to `toMs` after the start.
    func move(_ split: MotionSplit, everyMs: Int, fromMs: Int = 0, toMs: Int) {
        let start = clock
        for ms in stride(from: fromMs, to: toMs, by: everyMs) { frames.append((start + UInt64(ms) * 1_000_000, split)) }
        frames.sort { $0.atNs < $1.atNs }
    }

    private static func merged(_ rects: [PixelRect]) -> [PixelRect] {
        rects.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }
}

@Suite("Settle loop")
struct SettleLoopTests {
    private let tree = TreeRead(fingerprint: "33ef18e57b51af54", alertSuspected: false)
    private let caret = MotionSplit(blocking: [], ignored: [PixelRect(x: 72, y: 900, width: 16, height: 112)])
    private let shimmer = MotionSplit(blocking: [PixelRect(x: 0, y: 600, width: 1206, height: 400)], ignored: [])
    private var options: SettleOptions { SettleOptions(windowMs: 400, timeoutMs: 3_000) }

    @Test("a still screen settles after one window and two agreeing reads")
    func staticScreen() {
        let signals = ScriptedSignals(tree: [tree])
        let outcome = SettleLoop.run(options, signals)
        #expect(outcome.settled)
        #expect(outcome.basis == .pixelsAndTree)
        #expect(outcome.treeReads == 2 && outcome.treeStable == true)
        #expect(outcome.waitedMs == 460, "400 ms window plus two 30 ms reads")
    }

    @Test("a screen already known still for a window (an earlier attachment saw no frame) settles on the reads alone")
    func knownStill() {
        let outcome = SettleLoop.run(options, ScriptedSignals(tree: [tree], knownSinceMsAgo: 2_000))
        #expect(outcome.settled && outcome.waitedMs == 60)
    }

    @Test("a blinking caret does not hold settle up; it is reported as ignored")
    func caretBlink() {
        let signals = ScriptedSignals(tree: [tree])
        signals.move(caret, everyMs: 500, toMs: 10_000)
        let outcome = SettleLoop.run(options, signals)
        #expect(outcome.settled)
        #expect(outcome.motion.blocking.isEmpty)
        #expect(outcome.waitedMs < 1_000)
    }

    @Test("a shimmer that never stops answers settledWithMotion at the timeout, naming the moving region")
    func shimmerTimesOut() {
        let signals = ScriptedSignals(tree: [tree])
        signals.move(shimmer, everyMs: 16, toMs: 10_000)
        let outcome = SettleLoop.run(options, signals)
        #expect(!outcome.settled)
        #expect(outcome.motion.blocking == shimmer.blocking)
        #expect(outcome.waitedMs >= 3_000 && outcome.waitedMs < 3_100)
        #expect(outcome.treeReads == 0)
    }

    @Test("an animation that stops settles one window after its last frame")
    func animationEnds() {
        let signals = ScriptedSignals(tree: [tree])
        signals.move(shimmer, everyMs: 16, toMs: 700)
        let outcome = SettleLoop.run(options, signals)
        #expect(outcome.settled)
        // Last frame at 688 ms, still from then on; the poll lands within 50 ms of the window's end.
        #expect(outcome.waitedMs >= 1_088 + 60 && outcome.waitedMs < 1_088 + 60 + 60)
    }

    @Test("a tree still changing on a still screen is read until two reads agree")
    func treeChanges() {
        let loading = TreeRead(fingerprint: "e3b0c44298fc1c14", alertSuspected: false)
        let outcome = SettleLoop.run(options, ScriptedSignals(tree: [loading, tree, tree]))
        #expect(outcome.settled && outcome.treeReads == 3)
        #expect(outcome.tree == tree)
    }

    @Test("a failing tree read leaves pixels alone to decide")
    func treeFails() {
        let outcome = SettleLoop.run(options, ScriptedSignals(tree: [nil]))
        #expect(outcome.settled && outcome.basis == .pixels && outcome.treeStable == nil)
    }

    @Test("without pixels two reads a window apart decide; without either, the answer is settledWithMotion")
    func treeOnly() {
        let outcome = SettleLoop.run(options, ScriptedSignals(pixels: false, tree: [tree]))
        #expect(outcome.settled && outcome.basis == .tree)
        #expect(outcome.waitedMs >= 400)
        let blind = SettleLoop.run(options, ScriptedSignals(pixels: false, tree: [nil]))
        #expect(!blind.settled && blind.basis == .tree)
    }

    @Test("with neither pixels nor a tree nothing is settled, at once")
    func blind() {
        let outcome = SettleLoop.run(options, ScriptedSignals(pixels: false, tree: []))
        #expect(!outcome.settled && outcome.basis == .tree && outcome.treeReads == 0)
    }

    @Test("a screen with no tree settles on pixels alone")
    func pixelsOnly() {
        let outcome = SettleLoop.run(options, ScriptedSignals(tree: []))
        #expect(outcome.settled && outcome.basis == .pixels && outcome.treeReads == 0 && outcome.waitedMs == 400)
    }
}

@Suite("Damage watch")
struct DamageWatchTests {
    @Test("a watch with no framebuffer, or one not 4 bytes per pixel, sees no pixels; a BGRA one does")
    func baseline() {
        let rgb565 = makeSurface(width: 32, height: 32, bytesPerElement: 2, format: 0x4C35_3635) // 'L565'
        let bgra = makeSurface(width: 32, height: 32, bytesPerElement: 4, format: 0x4247_5241)
        for (source, sees) in [({ () -> IOSurfaceRef? in rgb565 }, false), ({ nil }, false), ({ bgra }, true)] {
            let watch = DamageWatch(surface: source)
            #expect(watch.start() == sees)
            watch.stop()
        }
    }
}
