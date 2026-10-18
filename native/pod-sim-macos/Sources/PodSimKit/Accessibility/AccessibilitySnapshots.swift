import CoreGraphics
import Foundation

/// `ax`'s answer: the frozen contract's `state` nodes and counts, plus what settle and the runtime need.
public struct AXSnapshotResult: Codable, Equatable, Sendable {
    public struct App: Codable, Equatable, Sendable {
        public let pid: Int
    }

    public let udid: String
    public let screen: AXScreen
    public let app: App?
    public let nodes: [AXNode]
    public let total: Int
    public let shown: Int
    public let omitted: Int
    public let notVisible: Int
    /// The tree collapsed to the application element: system UI the tree cannot show (a keyboard tip,
    /// AutoFill's "Save Password?") may cover the app; take a screenshot. iOS's "Allow Paste" prompt
    /// is not one of these: SpringBoard becomes the frontmost application and its buttons are listed.
    public let alertSuspected: Bool
    /// Changes only when what is on screen changes (AXFingerprint); stage 2b's settle compares two.
    public let fingerprint: String
    public let ms: Int
    /// Which path carried the requests: `bridge` (straight to the device), `coreSimulator`, or
    /// `fallback` (a public driver, with `degraded`).
    public let transport: String
    /// Set when a public fallback read the tree instead of the translator: the version table's reason.
    public var degraded: String? = nil
    /// How the tree was read: `cache` (kept from an earlier read; nothing changed since), `parallel`
    /// (read now, many requests at once), `translator` (read now through the translator, one request
    /// at a time). Absent from a public fallback.
    public var basis: AXBasis? = nil
    /// Why a `parallelWalk` helper read through the translator instead.
    public var fallbackReason: String? = nil
}

public enum AXBasis: String, Codable, Sendable {
    case cache, parallel, translator
}

/// How a fresh read goes, from the version table's `ax` pick: `parallelWalk` reads over several bridge
/// connections at once and falls back to the translator walk per read; `translatorWalk` only walks.
enum AXRoute: Equatable, Sendable {
    case parallel, translator
}

/// Reads one device's tree under a time budget, in parallel over the device's bridge or through the
/// translator, and answers `ax` from the last read while nothing changed (AXDeviceSession). Walks of
/// different devices through the translator take turns (it is single-threaded); a walk stops at its
/// budget, so a device whose accessibility server hangs costs others at most that budget.
enum AccessibilitySnapshots {
    /// Inside `ax`'s 5,000 ms deadline: the walk's budget plus one request that started just before it.
    static let walkBudgetMs = 2_500
    static let requestTimeout: TimeInterval = 1.5
    /// Requests under way at once per read. On an iPhone 16 Pro (iOS 26.5) Safari with the keyboard up
    /// (41 elements) read in 26 ms at 8 against 89 ms at 1; 16 was no faster: the app answers them.
    static let lanes = 8

    private static let routeLock = NSLock()
    nonisolated(unsafe) private static var configured: (route: AXRoute, note: String?) = (.translator, nil)

    /// Set once from the version table's pick, before the self-test.
    @discardableResult
    static func configure(implementation: String?) -> (route: AXRoute, note: String?) {
        // The translator's classes are there to look at only once it is loaded.
        let loaded = implementation == "parallelWalk" && (try? AXTranslatorBridge.shared().get()) != nil
        let chosen = choose(
            implementation: implementation, translatorLoaded: loaded,
            missing: loaded ? AXBridgeRequests.missingSymbols() + SimXPCService.missingSymbols() : [])
        routeLock.withLock { configured = chosen }
        return chosen
    }

    /// `parallelWalk` needs its own symbols too (the request classes, libxpc's `_4sim` calls and
    /// `-[SimDevice lookup:error:]`); without them reads go through the translator, said in `note`.
    static func choose(implementation: String?, translatorLoaded: Bool, missing: [String]) -> (route: AXRoute, note: String?) {
        guard implementation == "parallelWalk", translatorLoaded else { return (.translator, nil) }
        return missing.isEmpty ? (.parallel, nil) : (.translator, "parallelWalk lacks \(missing.joined(separator: ", ")); reads go through the translator")
    }

    static var route: (route: AXRoute, note: String?) { routeLock.withLock { configured } }

    /// A fresh read on the configured route (settle and the self-test compare reads, so never the
    /// kept tree), kept under `surface`'s stamp for the next `ax`. `force` reads in parallel even while
    /// that route is paused for the device (the self-test says how it is now).
    static func take(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool,
        surface: () -> (id: UInt32, seed: UInt32)? = { nil }, force: Bool = false
    ) -> Result<AXSnapshotResult, HelperError> {
        snapshot(device, options: options, hitTest: hitTest, fresh: true, surface: surface, force: force)
    }

    /// `ax`: the kept tree while its stamp still holds (`surface` gives the framebuffer's id and seed),
    /// else a fresh read, which is kept in turn.
    static func snapshot(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool, fresh: Bool,
        surface: () -> (id: UInt32, seed: UInt32)?, force: Bool = false
    ) -> Result<AXSnapshotResult, HelperError> {
        let started = DispatchTime.now()
        // The device may answer the translator when our own requests failed (a service that moved).
        // Both share one budget, so a fallback still answers inside `ax`'s deadline.
        let translator = { timed(device, options: options, hitTest: hitTest, started: started).map(\.result) }
        guard route.route == .parallel else {
            return translator().map { taken in
                var result = taken
                result.basis = .translator
                return result
            }
        }
        return AXParallelFallback.answer(
            key: .init(udid: device.udid, boot: device.lastBootedAt), backoff: .shared, force: force,
            parallel: { parallelSnapshot(device, options: options, hitTest: hitTest, fresh: fresh, surface: surface, started: started) },
            translator: translator, log: HelperLog.note)
    }

    private static func parallelSnapshot(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool, fresh: Bool,
        surface: () -> (id: UInt32, seed: UInt32)?, started: DispatchTime
    ) -> Result<AXSnapshotResult, AXParallelFailure> {
        let bridge: AXTranslatorBridge
        switch AXTranslatorBridge.shared() {
        case .failure(let error): return .failure(AXParallelFailure(kind: .unavailable, error: error))
        case .success(let loaded): bridge = loaded
        }
        let vocabulary: AXBridgeRequests.Vocabulary
        switch AXBridgeRequests.vocabulary() {
        case .failure(let error): return .failure(AXParallelFailure(kind: .unavailable, error: error))
        case .success(let learned): vocabulary = learned
        }
        let session: AXDeviceSession
        switch AXDeviceSessions.shared.session(for: device, vocabulary: vocabulary, timeout: requestTimeout) {
        case .failure(let error): return .failure(AXParallelFailure(kind: .lookup, error: error))
        case .success(let made): session = made
        }
        let deadline = started + .milliseconds(walkBudgetMs)
        let lanes = Lanes(session: session, vocabulary: vocabulary)
        defer { lanes.close() }
        var answer: AXKeptTree.Answer
        switch AXKeptTree.answer(
            keeper: session, fresh: fresh, surface: surface,
            read: { read(device, bridge: bridge, vocabulary: vocabulary, lanes: lanes, deadline: deadline) },
            discard: { AXDeviceSessions.shared.discard(session) }) {
        case .failure(let failure): return .failure(failure)
        case .success(let given): answer = given
        }
        let screen = Self.screen(device, rootFrame: answer.tree.elements.first?.frame)
        if hitTest {
            let bounds = CGRect(x: 0, y: 0, width: screen.width, height: screen.height)
            let wanted = AXTreeReader.hitPoints(answer.tree.elements, parents: answer.tree.parents, screen: bounds, filter: options.filter)
                .enumerated().compactMap { index, point in point.flatMap { answer.hits[index] == nil ? (index, $0) : nil } }
            if !wanted.isEmpty {
                let hits = AXParallelWalk.hitTests(wanted.map(\.1), lanes: lanes.open(min(wanted.count, Self.lanes)), deadline: deadline)
                let families = AXCovering.families(objectIDs: answer.tree.objectIDs, parents: answer.tree.parents)
                var found: [Int: Bool?] = [:]
                // An unanswered hit test is asked again next time; "cannot tell" is an answer and kept.
                for ((index, _), hit) in zip(wanted, hits) {
                    guard let hit else { continue }
                    found[index] = .some(AXCovering.lands(
                        hit, element: index, families: families, pids: answer.tree.pids, root: answer.tree.objectIDs.first ?? nil))
                }
                answer.hits.merge(found) { _, new in new }
                session.addHits(found, stamp: answer.stamp)
            }
            for (index, landed) in answer.hits { answer.tree.elements[index].hitsItself = landed }
        }
        var result = assemble(
            device, screen: screen, elements: answer.tree.elements, appPid: answer.tree.appPid, options: options,
            started: started, transport: "bridge")
        result.basis = answer.basis
        return .success(result)
    }

    /// The frontmost application's tree over the session's lanes.
    private static func read(
        _ device: SimDeviceHandle, bridge: AXTranslatorBridge, vocabulary: AXBridgeRequests.Vocabulary, lanes: Lanes, deadline: DispatchTime
    ) -> Result<AXTreeRead, AXParallelFailure> {
        let open = lanes.open(Self.lanes)
        guard let first = open.first as? AXBridgeReadLane else {
            return .failure(AXParallelFailure(kind: .unanswered, error: HelperError(.failed, "no connection to \(AXBridgeTransport.service)")))
        }
        let asked = DispatchSemaphore(value: 0)
        let app = AppBox()
        first.frontmost { app.set($0); asked.signal() }
        guard asked.wait(timeout: deadline) == .success, let root = app.value else {
            return .failure(AXParallelFailure(
                kind: .unanswered, error: HelperError(.failed, "no frontmost application answered (the device may still be starting)")))
        }
        let children = vocabulary.children
        let walked = AXParallelWalk.run(
            root: root, lanes: open, limits: .init(deadline: deadline),
            children: { ($0[children] as? [Any] ?? []).compactMap { $0 as? NSObject } })
        let reads: [AXParallelWalk.Read]
        switch walked {
        case .failure(let error): return .failure(AXParallelFailure(kind: .budget, error: error))
        case .success(let walk): reads = walk
        }
        return AXTranslatorBridge.queue.sync { AXBridgeValues.elements(reads, bridge: bridge, vocabulary: vocabulary) }
            .map { elements in
                AXTreeRead(
                    elements: elements, parents: reads.map(\.parent),
                    objectIDs: reads.map { AXTreeReader.number($0.element, "objectID")?.uint64Value },
                    pids: reads.map { AXTreeReader.number($0.element, "pid")?.int32Value },
                    appPid: AXTreeReader.number(root, "pid")?.int32Value)
            }
            .mapError { AXParallelFailure(kind: .conversion, error: $0) }
    }

    /// One read's connections, made from the session's endpoint as needed and closed with the read:
    /// a connection that has asked something hears every notification, so none outlives its read.
    private final class Lanes: @unchecked Sendable {
        private let session: AXDeviceSession
        private let vocabulary: AXBridgeRequests.Vocabulary
        private var made: [AXBridgeReadLane] = []
        private static let replies = DispatchQueue(label: "pod-sim.ax.lane-events", qos: .userInitiated)

        init(session: AXDeviceSession, vocabulary: AXBridgeRequests.Vocabulary) {
            self.session = session
            self.vocabulary = vocabulary
        }

        func open(_ count: Int) -> [AXLane] {
            while made.count < count, let lane = session.endpoint.connect(queue: Self.replies, onEvent: { _ in }) {
                made.append(AXBridgeReadLane(lane, vocabulary: vocabulary, timeout: AccessibilitySnapshots.requestTimeout))
            }
            return Array(made.prefix(count))
        }

        func close() {
            for lane in made { lane.lane.cancel() }
        }
    }

    private final class AppBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: NSObject?
        func set(_ value: NSObject?) { lock.withLock { stored = value } }
        var value: NSObject? { lock.withLock { stored } }
    }

    /// The translator walk and where its time went (the fallback, probes and tests; not on the wire).
    static func timed(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool, started: DispatchTime = .now()
    ) -> Result<(result: AXSnapshotResult, timings: AXWalkTimings, requests: Int, transportMs: Double), HelperError> {
        let bridge: AXTranslatorBridge
        switch AXTranslatorBridge.shared() {
        case .failure(let error): return .failure(error)
        case .success(let loaded): bridge = loaded
        }
        let deviceScreen = DeviceScreen.of(device)
        let transport = AXTransports.shared.transport(for: device)
        let (token, route) = bridge.register(transport, requestTimeout: requestTimeout)
        defer { bridge.unregister(token) }
        let walked = AXTranslatorBridge.queue.sync {
            AXTreeReader.walk(
                bridge: bridge, token: token, screenPoints: deviceScreen.points,
                limits: .init(deadline: started + .milliseconds(walkBudgetMs), hitTest: hitTest, filter: options.filter))
        }
        // Nothing answered: the service may have gone (CoreSimulatorBridge restarts); connect again next time.
        if route.sent > 0, route.unanswered == route.sent { AXTransports.shared.discard(device.udid) }
        switch walked {
        case .failure(let error):
            return .failure(HelperError(error.code, "\(error.message) (\(route.unanswered) of \(route.sent) requests unanswered via \(transport.kind))"))
        case .success(let walk):
            let result = assemble(
                device, screen: screen(device, rootFrame: walk.rootFrame), elements: walk.elements, appPid: walk.appPid,
                options: options, started: started, transport: transport.kind)
            return .success((result, walk.timings, route.sent, route.transportMs))
        }
    }

    /// The screen a read saw: the application element spans it in the orientation the app is in
    /// (recorded for `hid`), else the device's own.
    private static func screen(_ device: SimDeviceHandle, rootFrame: CGRect?) -> AXScreen {
        let deviceScreen = DeviceScreen.of(device)
        let root = rootFrame.map { AXNormalizer.finite($0).size }.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
        let points = root ?? deviceScreen.points
        let orientation = root.flatMap { InterfaceOrientation.of(root: $0, native: deviceScreen.points) }
        DeviceOrientations.shared.record(orientation, for: device)
        return AXScreen(width: Double(points.width), height: Double(points.height), scale: deviceScreen.scale, orientation: orientation)
    }

    /// `ax`'s answer from a read's elements, normalized as `options` asks.
    private static func assemble(
        _ device: SimDeviceHandle, screen: AXScreen, elements: [AXRawElement], appPid: Int32?, options: AXSnapshotOptions,
        started: DispatchTime, transport: String
    ) -> AXSnapshotResult {
        let normalized = AXNormalizer.normalize(elements, screen: screen, options: options)
        return AXSnapshotResult(
            udid: device.udid, screen: screen, app: appPid.map { AXSnapshotResult.App(pid: Int($0)) },
            nodes: normalized.nodes, total: normalized.total, shown: normalized.shown, omitted: normalized.omitted,
            notVisible: normalized.notVisible, alertSuspected: normalized.alertSuspected, fingerprint: normalized.fingerprint,
            ms: Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000), transport: transport)
    }
}

extension AccessibilitySnapshots {
    /// The frontmost application's pid, or nil when it is not known within `timeout`: one request on
    /// a connection of its own on the parallel route, else through the translator (waiting for its
    /// queue included: another device's walk may hold it for its whole budget).
    static func frontmostPid(_ device: SimDeviceHandle, timeout: TimeInterval) -> Int32? {
        if route.route == .parallel, let session = AXDeviceSessions.shared.existing(device.udid), session.device === device.object,
           case .success(let vocabulary) = AXBridgeRequests.vocabulary(),
           let lane = session.endpoint.connect(queue: DispatchQueue(label: "pod-sim.ax.frontmost"), onEvent: { _ in }) {
            defer { lane.cancel() }
            let answer = PidAnswer()
            AXBridgeReadLane(lane, vocabulary: vocabulary, timeout: timeout).frontmost { app in
                answer.set(AXTreeReader.number(app, "pid")?.int32Value)
            }
            return answer.wait(timeout: timeout)
        }
        guard case .success(let bridge) = AXTranslatorBridge.shared() else { return nil }
        let transport = AXTransports.shared.transport(for: device)
        let answer = PidAnswer()
        AXTranslatorBridge.queue.async {
            guard !answer.abandoned else { return }
            let (token, _) = bridge.register(transport, requestTimeout: timeout)
            defer { bridge.unregister(token) }
            answer.set(AXTreeReader.frontmostPid(bridge: bridge, token: token))
        }
        return answer.wait(timeout: timeout)
    }
}

/// A pid read on the translator queue; a waiter that gave up stops a read that has not started.
private final class PidAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var pid: Int32?
    private var gaveUp = false

    var abandoned: Bool { lock.withLock { gaveUp } }

    func set(_ value: Int32?) {
        lock.withLock { pid = value }
        done.signal()
    }

    func wait(timeout: TimeInterval) -> Int32? {
        if done.wait(timeout: .now() + timeout) == .success { return lock.withLock { pid } }
        lock.withLock { gaveUp = true }
        return nil
    }
}

/// The main screen in device points, from the device type (pixels and scale).
struct DeviceScreen {
    let points: CGSize
    let scale: Double

    static func of(_ device: SimDeviceHandle) -> DeviceScreen {
        let scale = Double(mainScreenScale(device.object) ?? 0)
        guard scale > 0, device.screenPixels.width > 0 else {
            return DeviceScreen(points: device.screenPixels, scale: 1)
        }
        return DeviceScreen(
            points: CGSize(width: device.screenPixels.width / scale, height: device.screenPixels.height / scale), scale: scale)
    }

    private static func mainScreenScale(_ device: NSObject) -> Float? {
        let read = ObjCGuard.attempt("mainScreenScale") { () -> Float? in
            guard let type = device.value(forKey: "deviceType") as? NSObject else { return nil }
            typealias ScaleFn = @convention(c) (AnyObject, Selector) -> Float
            let selector = NSSelectorFromString("mainScreenScale")
            guard type.responds(to: selector) else { return nil }
            return unsafeBitCast(type.method(for: selector), to: ScaleFn.self)(type, selector)
        }
        guard case .success(let scale) = read else { return nil }
        return scale
    }
}
