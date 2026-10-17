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

    /// Set once from the version table's pick, before the self-test: `parallelWalk` needs its own
    /// symbols too, and without them reads go through the translator, said in `note`.
    @discardableResult
    static func configure(implementation: String?) -> (route: AXRoute, note: String?) {
        var chosen: (route: AXRoute, note: String?) = (.translator, nil)
        // The translator's classes are there to look at only once it is loaded.
        if implementation == "parallelWalk", case .success = AXTranslatorBridge.shared() {
            let missing = AXBridgeRequests.missingSymbols()
            chosen = missing.isEmpty
                ? (.parallel, nil)
                : (.translator, "parallelWalk lacks \(missing.joined(separator: ", ")); reads go through the translator")
        }
        routeLock.withLock { configured = chosen }
        return chosen
    }

    static var route: (route: AXRoute, note: String?) { routeLock.withLock { configured } }

    /// A fresh read on the configured route (settle and the self-test compare reads, so never the cache).
    static func take(_ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool) -> Result<AXSnapshotResult, HelperError> {
        snapshot(device, options: options, hitTest: hitTest, fresh: true, surface: { nil })
    }

    /// `ax`: the kept tree while its stamp still holds (`surface` gives the framebuffer's id and seed),
    /// else a fresh read, which is kept in turn.
    static func snapshot(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool, fresh: Bool,
        surface: () -> (id: UInt32, seed: UInt32)?
    ) -> Result<AXSnapshotResult, HelperError> {
        let started = DispatchTime.now()
        guard route.route == .parallel else {
            return timed(device, options: options, hitTest: hitTest).map { taken in
                var result = taken.result
                result.basis = .translator
                return result
            }
        }
        let parallel = parallelSnapshot(device, options: options, hitTest: hitTest, fresh: fresh, surface: surface, started: started)
        guard case .failure(let failure) = parallel else { return parallel }
        // The device may answer the translator when our own requests failed (a service that moved).
        // Both share one budget, so a fallback still answers inside `ax`'s deadline.
        HelperLog.note("ax \(device.udid): \(failure.message); reading through the translator")
        return timed(device, options: options, hitTest: hitTest, started: started)
            .map { taken in
                var result = taken.result
                result.basis = .translator
                result.fallbackReason = failure.message
                return result
            }
            .mapError { HelperError($0.code, "\(failure.message); through the translator: \($0.message)") }
    }

    private static func parallelSnapshot(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool, fresh: Bool,
        surface: () -> (id: UInt32, seed: UInt32)?, started: DispatchTime
    ) -> Result<AXSnapshotResult, HelperError> {
        let bridge: AXTranslatorBridge
        switch AXTranslatorBridge.shared() {
        case .failure(let error): return .failure(error)
        case .success(let loaded): bridge = loaded
        }
        let vocabulary: AXBridgeRequests.Vocabulary
        switch AXBridgeRequests.vocabulary() {
        case .failure(let error): return .failure(error)
        case .success(let learned): vocabulary = learned
        }
        let session: AXDeviceSession
        switch AXDeviceSessions.shared.session(for: device, vocabulary: vocabulary, timeout: requestTimeout) {
        case .failure(let error): return .failure(error)
        case .success(let made): session = made
        }
        let deadline = started + .milliseconds(walkBudgetMs)
        let deviceScreen = DeviceScreen.of(device)
        // Taken before anything is read, so a change while reading leaves a stamp that no longer holds.
        let stamp = session.stamp(surface: surface())
        let lanes = Lanes(session: session, vocabulary: vocabulary)
        defer { lanes.close() }
        var basis = AXBasis.cache
        var tree: AXTreeRead
        var hits: [Int: Bool?]
        if !fresh, let kept = session.cached(at: stamp) {
            (tree, hits) = kept
        } else {
            switch read(device, bridge: bridge, vocabulary: vocabulary, lanes: lanes, deadline: deadline) {
            case .failure(let error):
                // Nothing answered on its connections: the endpoint may be stale (the service restarted).
                if error.unanswered { AXDeviceSessions.shared.discard(session) }
                return .failure(error.error)
            case .success(let read): tree = read
            }
            hits = [:]
            basis = .parallel
            session.keep(tree, stamp: stamp)
        }
        let rootSize = tree.elements.first.map { AXNormalizer.finite($0.frame).size }.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
        let points = rootSize ?? deviceScreen.points
        if hitTest {
            let wanted = AXTreeReader.hitPoints(tree.elements, parents: tree.parents, screen: CGRect(origin: .zero, size: points), filter: options.filter)
                .enumerated().compactMap { index, point in point.flatMap { hits[index] == nil ? (index, $0) : nil } }
            if !wanted.isEmpty {
                let answers = AXParallelWalk.hitTests(wanted.map(\.1), lanes: lanes.open(min(wanted.count, Self.lanes)), deadline: deadline)
                let families = AXCovering.families(objectIDs: tree.objectIDs, parents: tree.parents)
                var found: [Int: Bool?] = [:]
                // An unanswered hit test is asked again next time; "cannot tell" is an answer and kept.
                for ((index, _), hit) in zip(wanted, answers) {
                    guard let hit else { continue }
                    found[index] = .some(AXCovering.lands(hit, element: index, families: families, pids: tree.pids, root: tree.objectIDs.first ?? nil))
                }
                hits.merge(found) { _, new in new }
                session.addHits(found, stamp: stamp)
            }
            for (index, landed) in hits { tree.elements[index].hitsItself = landed }
        }
        let orientation = rootSize.flatMap { InterfaceOrientation.of(root: $0, native: deviceScreen.points) }
        DeviceOrientations.shared.record(orientation, for: device)
        let screen = AXScreen(width: Double(points.width), height: Double(points.height), scale: deviceScreen.scale, orientation: orientation)
        let normalized = AXNormalizer.normalize(tree.elements, screen: screen, options: options)
        var result = AXSnapshotResult(
            udid: device.udid, screen: screen, app: tree.appPid.map { AXSnapshotResult.App(pid: Int($0)) },
            nodes: normalized.nodes, total: normalized.total, shown: normalized.shown, omitted: normalized.omitted,
            notVisible: normalized.notVisible, alertSuspected: normalized.alertSuspected, fingerprint: normalized.fingerprint,
            ms: Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000), transport: "bridge")
        result.basis = basis
        return .success(result)
    }

    /// The frontmost application's tree over the session's lanes.
    private struct ReadFailure: Error {
        let error: HelperError
        /// The device answered nothing at all.
        let unanswered: Bool
    }

    private static func read(
        _ device: SimDeviceHandle, bridge: AXTranslatorBridge, vocabulary: AXBridgeRequests.Vocabulary, lanes: Lanes, deadline: DispatchTime
    ) -> Result<AXTreeRead, ReadFailure> {
        let open = lanes.open(Self.lanes)
        guard let first = open.first as? AXBridgeReadLane else {
            return .failure(ReadFailure(error: HelperError(.failed, "no connection to \(AXBridgeTransport.service)"), unanswered: true))
        }
        let asked = DispatchSemaphore(value: 0)
        let app = AppBox()
        first.frontmost { app.set($0); asked.signal() }
        guard asked.wait(timeout: deadline) == .success, let root = app.value else {
            return .failure(ReadFailure(
                error: HelperError(.failed, "no frontmost application answered (the device may still be starting)"), unanswered: true))
        }
        let children = vocabulary.children
        let walked = AXParallelWalk.run(
            root: root, lanes: open, limits: .init(deadline: deadline),
            children: { ($0[children] as? [Any] ?? []).compactMap { $0 as? NSObject } })
        return walked.flatMap { reads in
            AXTranslatorBridge.queue.sync { AXBridgeValues.elements(reads, bridge: bridge, vocabulary: vocabulary) }.map { elements in
                AXTreeRead(
                    elements: elements, parents: reads.map(\.parent),
                    objectIDs: reads.map { AXTreeReader.number($0.element, "objectID")?.uint64Value },
                    pids: reads.map { AXTreeReader.number($0.element, "pid")?.int32Value },
                    appPid: AXTreeReader.number(root, "pid")?.int32Value, device: device.object)
            }
        }
        .mapError { ReadFailure(error: $0, unanswered: false) }
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
            // The application element spans the screen in the orientation the app is in.
            let root = walk.rootFrame.flatMap { AXNormalizer.finite($0).size }.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            let points = root ?? deviceScreen.points
            let orientation = root.flatMap { InterfaceOrientation.of(root: $0, native: deviceScreen.points) }
            DeviceOrientations.shared.record(orientation, for: device)
            let screen = AXScreen(
                width: Double(points.width), height: Double(points.height), scale: deviceScreen.scale, orientation: orientation)
            let normalized = AXNormalizer.normalize(walk.elements, screen: screen, options: options)
            let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
            let result = AXSnapshotResult(
                udid: device.udid, screen: screen, app: walk.appPid.map { AXSnapshotResult.App(pid: Int($0)) },
                nodes: normalized.nodes, total: normalized.total, shown: normalized.shown, omitted: normalized.omitted,
                notVisible: normalized.notVisible, alertSuspected: normalized.alertSuspected,
                fingerprint: normalized.fingerprint, ms: ms, transport: transport.kind)
            return .success((result, walk.timings, route.sent, route.transportMs))
        }
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
