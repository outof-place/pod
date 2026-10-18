import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

private func eventually(_ seconds: Double = 3, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !condition() {
        if Date() > end { return false }
        Thread.sleep(forTimeInterval: 0.01)
    }
    return true
}

private func tree(_ appPid: Int32 = 1) -> AXTreeRead {
    AXTreeRead(elements: [], parents: [], objectIDs: [], pids: [], appPid: appPid)
}

/// A kept tree as a session keeps it, with notifications heard (`notify`) and no connection.
final class StubKeeper: AXTreeKeeper {
    private var cache = AXTreeCache()
    init() { cache.listen() }
    func notify() { cache.changed() }
    func stamp(surface: (id: UInt32, seed: UInt32)?) -> AXScreenStamp? { cache.stamp(surface: surface) }
    func cached(at now: AXScreenStamp?) -> (tree: AXTreeRead, hits: [Int: Bool?])? { cache.cached(at: now) }
    func keep(_ tree: AXTreeRead, stamp: AXScreenStamp?) { cache.keep(tree, stamp: stamp) }
}

/// The framebuffer's id and seed as the stamp reads them; `seed` moves when the device draws.
final class StubScreen {
    var seed: UInt32 = 41
    var readable = true
    var surface: (id: UInt32, seed: UInt32)? { readable ? (3, seed) : nil }
}

final class LoggedLines: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    func add(_ line: String) { lock.withLock { stored.append(line) } }
    var all: [String] { lock.withLock { stored } }
}

@Suite("Accessibility kept tree decision")
struct AXKeptTreeDecisionTests {
    let keeper = StubKeeper()
    let screen = StubScreen()

    /// One `ax` through the decision; `during` runs while the device is being read. The read answers
    /// a tree whose app pid counts the reads, so a served tree says which read it was.
    final class Device {
        var reads: Int32 = 0
        var discards = 0
        var fails: AXParallelFailure.Kind?
    }

    func ask(_ device: Device, fresh: Bool = false, during: () -> Void = {}) -> AXKeptTree.Answer? {
        let answered = AXKeptTree.answer(
            keeper: keeper, fresh: fresh, surface: { screen.surface },
            read: {
                device.reads += 1
                during()
                if let kind = device.fails { return .failure(AXParallelFailure(kind: kind, error: HelperError(.failed, kind.rawValue))) }
                return .success(tree(device.reads))
            },
            discard: { device.discards += 1 })
        return try? answered.get()
    }

    @Test("a still screen is answered from the kept tree")
    func stillScreen() {
        let device = Device()
        #expect(ask(device)?.basis == .parallel)
        let kept = ask(device)
        #expect(kept?.basis == .cache && kept?.tree.appPid == 1)
        #expect(device.reads == 1)
    }

    @Test("a notification that arrives during the read is never answered from on the next call")
    func notificationDuringRead() {
        let device = Device()
        #expect(ask(device, during: { keeper.notify() })?.basis == .parallel)
        #expect(ask(device)?.basis == .parallel)
        #expect(device.reads == 2)
    }

    @Test("a redraw during the read (a new seed) is never answered from on the next call")
    func redrawDuringRead() {
        let device = Device()
        #expect(ask(device, during: { screen.seed += 1 })?.basis == .parallel)
        #expect(ask(device)?.basis == .parallel)
        #expect(device.reads == 2)
    }

    @Test("fresh never answers from the kept tree, and what it read is kept for the next call (settle's last read)")
    func freshReadsAndKeeps() {
        let device = Device()
        _ = ask(device)
        let fresh = ask(device, fresh: true)
        #expect(fresh?.basis == .parallel && fresh?.tree.appPid == 2)
        let next = ask(device)
        #expect(next?.basis == .cache && next?.tree.appPid == 2)
    }

    @Test("a fresh read without a framebuffer stamp is not kept, and the tree kept before still answers while its stamp holds")
    func unstampedFreshRead() {
        let device = Device()
        _ = ask(device)
        screen.readable = false
        #expect(ask(device, fresh: true)?.basis == .parallel)
        screen.readable = true
        let next = ask(device)
        #expect(next?.basis == .cache && next?.tree.appPid == 1)
    }

    @Test("a read the device answered nothing to discards the session; a slow or unconvertible one keeps it")
    func unansweredDiscards() {
        for (kind, discards) in [(AXParallelFailure.Kind.unanswered, 1), (.budget, 0), (.conversion, 0)] {
            let device = Device()
            device.fails = kind
            #expect(ask(device) == nil)
            #expect(device.discards == discards, "\(kind)")
        }
    }
}

@Suite("Accessibility parallel fallback")
struct AXParallelFallbackTests {
    let key = AXParallelBackoff.Key(udid: "A", boot: Date(timeIntervalSince1970: 1_000))

    static func result(_ basis: AXBasis? = nil) -> AXSnapshotResult {
        var made = AXSnapshotResult(
            udid: "A", screen: AXScreen(width: 402, height: 874, scale: 3, orientation: nil), app: nil, nodes: [], total: 0, shown: 0,
            omitted: 0, notVisible: 0, alertSuspected: false, fingerprint: "f", ms: 1, transport: "bridge")
        made.basis = basis
        return made
    }

    static func failing(_ kind: AXParallelFailure.Kind, _ message: String = "no frontmost application answered") -> AXParallelFailure {
        AXParallelFailure(kind: kind, error: HelperError(.failed, message))
    }

    final class Calls {
        var parallel = 0
        var translator = 0
    }

    func ax(
        _ backoff: AXParallelBackoff, _ calls: Calls, force: Bool = false, key: AXParallelBackoff.Key? = nil,
        parallel: Result<AXSnapshotResult, AXParallelFailure>,
        translator: Result<AXSnapshotResult, HelperError> = .success(result()), log: LoggedLines = LoggedLines()
    ) -> Result<AXSnapshotResult, HelperError> {
        AXParallelFallback.answer(
            key: key ?? self.key, backoff: backoff, force: force,
            parallel: { calls.parallel += 1; return parallel }, translator: { calls.translator += 1; return translator },
            log: log.add)
    }

    @Test("a failed parallel read answers through the translator and says so: basis translator, fallbackReason the failure")
    func fallbackSaysWhy() throws {
        let answered = try ax(AXParallelBackoff(pauseSeconds: 30), Calls(), parallel: .failure(Self.failing(.unanswered))).get()
        #expect(answered.basis == .translator)
        #expect(answered.fallbackReason == "no frontmost application answered")
    }

    @Test("both failing: the error carries both reasons")
    func bothFail() {
        let failed = ax(
            AXParallelBackoff(pauseSeconds: 30), Calls(), parallel: .failure(Self.failing(.conversion, "converting failed")),
            translator: .failure(HelperError(.failed, "walk failed")))
        guard case .failure(let error) = failed else { Issue.record("answered"); return }
        #expect(error.message == "converting failed; through the translator: walk failed")
    }

    @Test("a read past its budget is answered as it failed, never handed to the translator with nothing left")
    func budgetNotRetried() {
        let calls = Calls()
        let failed = ax(AXParallelBackoff(pauseSeconds: 30), calls, parallel: .failure(Self.failing(.budget, "the walk passed its budget")))
        guard case .failure(let error) = failed else { Issue.record("answered"); return }
        #expect(error.message == "the walk passed its budget")
        #expect(calls.translator == 0)
    }

    @Test("two failures in a row pause the parallel read for the device boot: the next call goes straight to the translator, saying why")
    func pauses() throws {
        let backoff = AXParallelBackoff(pauseSeconds: 30)
        let calls = Calls()
        for _ in 0..<2 { _ = ax(backoff, calls, parallel: .failure(Self.failing(.unanswered))) }
        let paused = try ax(backoff, calls, parallel: .success(Self.result(.parallel))).get()
        #expect(calls.parallel == 2)
        #expect(paused.basis == .translator)
        #expect(paused.fallbackReason?.hasPrefix("parallel reads paused for 30 s after 2 failures in a row") == true)
        // Another boot of the device starts over.
        let rebooted = AXParallelBackoff.Key(udid: "A", boot: Date(timeIntervalSince1970: 2_000))
        #expect(try ax(backoff, calls, key: rebooted, parallel: .success(Self.result(.parallel))).get().basis == .parallel)
    }

    @Test("reads past their budget neither count toward a pause nor end one")
    func budgetIsNeutral() {
        let backoff = AXParallelBackoff(pauseSeconds: 30)
        for _ in 0..<3 { _ = backoff.failed(key, Self.failing(.budget)) }
        #expect(backoff.paused(key) == nil)
        _ = backoff.failed(key, Self.failing(.unanswered))
        _ = backoff.failed(key, Self.failing(.budget))
        _ = backoff.failed(key, Self.failing(.unanswered))
        #expect(backoff.paused(key) != nil)
    }

    @Test("a pause ends after its time, and one more failure starts another; a success starts over")
    func pauseEnds() {
        let backoff = AXParallelBackoff(pauseSeconds: 30)
        let now = DispatchTime.now()
        _ = backoff.failed(key, Self.failing(.lookup), now: now)
        _ = backoff.failed(key, Self.failing(.lookup), now: now)
        #expect(backoff.paused(key, now: now + 29) != nil)
        #expect(backoff.paused(key, now: now + 31) == nil)
        _ = backoff.failed(key, Self.failing(.lookup), now: now + 31)
        #expect(backoff.paused(key, now: now + 32) != nil)
        backoff.succeeded(key)
        #expect(backoff.paused(key, now: now + 32) == nil)
        _ = backoff.failed(key, Self.failing(.lookup), now: now + 33)
        #expect(backoff.paused(key, now: now + 34) == nil)
    }

    @Test("the self-test's read tries the paused route, and its success ends the pause")
    func forcedReadEndsPause() throws {
        let backoff = AXParallelBackoff(pauseSeconds: 30)
        let calls = Calls()
        for _ in 0..<2 { _ = ax(backoff, calls, parallel: .failure(Self.failing(.unanswered))) }
        #expect(try ax(backoff, calls, force: true, parallel: .success(Self.result(.parallel))).get().basis == .parallel)
        #expect(try ax(backoff, calls, parallel: .success(Self.result(.parallel))).get().basis == .parallel)
        #expect(calls.parallel == 4)
    }

    @Test("each reason is logged once per device boot, and the pause once when it starts")
    func logsOncePerReason() {
        let backoff = AXParallelBackoff(pauseSeconds: 30)
        let log = LoggedLines()
        let calls = Calls()
        for _ in 0..<5 { _ = ax(backoff, calls, parallel: .failure(Self.failing(.unanswered)), log: log) }
        for _ in 0..<2 { _ = ax(backoff, calls, force: true, parallel: .failure(Self.failing(.budget, "past the budget")), log: log) }
        #expect(log.all == [
            "ax A: no frontmost application answered; reading through the translator",
            "ax A: no frontmost application answered; the next 30 s read through the translator",
            "ax A: past the budget; nothing is left of the budget for the translator",
        ])
    }
}

@Suite("Accessibility route choice and self-test note")
struct AXRouteNoteTests {
    @Test("parallelWalk without libxpc's _4sim calls or -[SimDevice lookup:error:] reads through the translator and says what is missing")
    func missingEndpointCalls() {
        let chosen = AccessibilitySnapshots.choose(implementation: "parallelWalk", translatorLoaded: true, missing: ["-[SimDevice lookup:error:]"])
        #expect(chosen.route == .translator)
        #expect(chosen.note == "parallelWalk lacks -[SimDevice lookup:error:]; reads go through the translator")
        #expect(AccessibilitySnapshots.choose(implementation: "parallelWalk", translatorLoaded: true, missing: []).route == .parallel)
        #expect(AccessibilitySnapshots.choose(implementation: "translatorWalk", translatorLoaded: true, missing: []).route == .translator)
    }

    @Test("the self-test's ax note says when no tree is kept, and why")
    func noteSaysNothingKept() {
        let snapshot = AXParallelFallbackTests.result(.parallel)
        let unheard = AccessibilityProbes.note(snapshot, routeNote: nil, listenProblem: "the notification connection ended")
        #expect(unheard == "0 elements under the frontmost application (no app pid) in 1 ms (parallel); no tree is kept: the notification connection ended")
        #expect(!AccessibilityProbes.note(snapshot, routeNote: nil, listenProblem: nil).contains("kept"))
    }

    @Test("a session that cannot listen logs why once, however often it asks again")
    func listenProblemLoggedOnce() {
        let log = LoggedLines()
        let session = AXDeviceSession(
            udid: "A", device: NSObject(), boot: nil, endpoint: AXDeviceSessionsTests.NoConnections(), listenRetrySeconds: 0, log: log.add)
        for _ in 0..<3 { session.listen(vocabulary: .init(attributes: [8], children: 8), timeout: 0.1) }
        #expect(log.all == [
            "ax A: no accessibility notifications (no connection to com.apple.CoreSimulator.accessibility), so no tree is kept; asked again at most every 0 s",
        ])
    }
}

/// Stands in for DTUHID (the table is forced unknown); `during` runs while the call is under way.
private final class InputDuring: PublicInputFallback, @unchecked Sendable {
    let during: @Sendable () -> Void
    init(_ during: @escaping @Sendable () -> Void) { self.during = during }

    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
        during()
        return .success(HIDResult(udid: udid, kind: action.kind, ms: 0, via: nil, typed: nil, frameAfterMs: nil, degraded: nil))
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool?
    var value: Bool? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

@Suite("Accessibility kept tree and input", .enabled(if: FakeAccessibilityService.available))
struct AXKeptTreeInputTests {
    @Test("a hid call ends the kept tree from the moment it arrives until it has landed")
    func hidEndsKeptTree() throws {
        let udid = UUID().uuidString
        let service = FakeAccessibilityService()
        let device = NSObject()
        let session = try AXDeviceSessions.shared.session(
            udid: udid, device: device, boot: nil, lookup: { .success(service) },
            listen: { $0.listen(vocabulary: .init(attributes: [8], children: 8), timeout: 2) }).get()
        defer { AXDeviceSessions.shared.discard(session) }
        #expect(eventually { session.isListening })
        let surface = (id: UInt32(1), seed: UInt32(1))
        session.keep(tree(), stamp: session.stamp(surface: surface))
        #expect(session.cached(at: session.stamp(surface: surface)) != nil)

        let goneWhileUnderWay = Flag()
        let readDuring = tree()
        // A read while the input is under way is kept under the stamp of that moment.
        let input = InputDuring {
            goneWhileUnderWay.value = session.cached(at: session.stamp(surface: surface)) == nil
            session.keep(readDuring, stamp: session.stamp(surface: surface))
        }
        let methods = HelperMethods(
            environment: ["DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer", "POD_SIM_FORCE_UNKNOWN_BUILD": "1"],
            inputFallback: input, accessibilityFallback: NoPublicAccessibilityFallback())
        let answered = DispatchSemaphore(value: 0)
        let request = Request(id: 1, method: "hid", params: Data(#"{"udid":"\#(udid)","action":{"kind":"tap","x":10,"y":10}}"#.utf8))
        let handled = methods.handle(request, reply: { _ in answered.signal() })
        #expect(handled)
        #expect(answered.wait(timeout: .now() + 5) == .success)
        #expect(goneWhileUnderWay.value == true)
        // What was read while the input landed is not the screen after it.
        #expect(session.cached(at: session.stamp(surface: surface)) == nil)
    }
}

@Suite("Accessibility listening wait", .enabled(if: FakeAccessibilityService.available))
struct AXListenWaitTests {
    @Test("the self-test waits for the listening connection's first answer instead of reporting it as not there yet")
    func waitsForFirstAnswer() {
        let service = FakeAccessibilityService()
        service.replyDelaysMs = [200]
        let session = AXDeviceSession(udid: "A", device: NSObject(), boot: nil, endpoint: service)
        session.listen(vocabulary: .init(attributes: [8], children: 8), timeout: 2)
        #expect(session.listenProblem(within: 2) == nil)
    }

    @Test("a service that never answers: the wait ends at the service's own timeout with the reason")
    func silentService() {
        let service = FakeAccessibilityService()
        service.silent = true
        let session = AXDeviceSession(udid: "A", device: NSObject(), boot: nil, endpoint: service, log: { _ in })
        session.listen(vocabulary: .init(attributes: [8], children: 8), timeout: 0.1)
        #expect(session.listenProblem(within: 2) == "the notification connection's first request went unanswered")
    }
}

@Suite("Accessibility value conversion", .enabled(if: FakeAccessibilityService.available))
struct AXValueConversionTests {
    /// The translator's number for a Mac attribute name, as the vocabulary learns it.
    func number(_ name: String) -> Int {
        AXTranslatorBridge.queue.sync {
            guard let element = AXBridgeRequests.platformElement(AXBridgeRequests.newTranslation()) else { return 0 }
            typealias Number = @convention(c) (AnyObject, Selector, NSString) -> UInt
            let selector = NSSelectorFromString("_attributeTypeForMacAttribute:")
            return Int(unsafeBitCast(element.method(for: selector), to: Number.self)(element, selector, name as NSString))
        }
    }

    func read(_ values: AXValues) -> AXParallelWalk.Read {
        let element = AXBridgeRequests.newTranslation()
        element.setValue(UInt64(7), forKey: "objectID")
        element.setValue(Int32(42), forKey: "pid")
        return AXParallelWalk.Read(element: element, parent: -1, depth: 0, values: values)
    }

    func convert(_ values: AXValues) throws -> Result<[AXRawElement], HelperError> {
        let bridge = try AXTranslatorBridge.shared().get()
        let vocabulary = try AXBridgeRequests.vocabulary().get()
        let reads = [read(values)]
        return AXTranslatorBridge.queue.sync { AXBridgeValues.elements(reads, bridge: bridge, vocabulary: vocabulary) }
    }

    // An AXP role (1, the application) whose conversion asks the device whether the element is another
    // process's (66), as every element's role does on translator 587.
    @Test("values convert from the read alone: the role's own question (66) is answered from what was read")
    func answeredFromTheRead() throws {
        let role = number("AXRole"), label = number("AXDescription")
        try #require(role != 0 && label != 0)
        let elements = try convert([role: NSNumber(value: 1), label: "Continue", 66: NSNumber(value: false)]).get()
        #expect(elements.map(\.role) == ["AXApplication"])
        #expect(elements.map(\.label) == ["Continue"])
    }

    @Test("a question the read has no answer for fails the conversion, so the call reads through the translator and says why")
    func gapFails() throws {
        let role = number("AXRole"), label = number("AXDescription")
        try #require(role != 0 && label != 0)
        guard case .failure(let error) = try convert([role: NSNumber(value: 1), label: "Continue"]) else {
            Issue.record("a conversion that asked a question the read could not answer passed as complete")
            return
        }
        #expect(error.message.contains("no answer"))
    }
}
