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
}

/// Reads one device's tree under a time budget. Walks of different devices take turns on the
/// translator queue (the translator is single-threaded); a walk stops at its budget, so a device
/// whose accessibility server hangs costs others at most that budget.
enum AccessibilitySnapshots {
    /// Inside `ax`'s 5,000 ms deadline: the walk's budget plus one request that started just before it.
    static let walkBudgetMs = 2_500
    static let requestTimeout: TimeInterval = 1.5

    static func take(_ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool) -> Result<AXSnapshotResult, HelperError> {
        timed(device, options: options, hitTest: hitTest).map(\.result)
    }

    /// The snapshot and where its time went (for probes and tests; not on the wire).
    static func timed(
        _ device: SimDeviceHandle, options: AXSnapshotOptions, hitTest: Bool
    ) -> Result<(result: AXSnapshotResult, timings: AXWalkTimings, requests: Int, transportMs: Double), HelperError> {
        let started = DispatchTime.now()
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
    /// The frontmost application's pid, or nil when it is not known within `timeout`, waiting for
    /// the translator queue included (another device's walk may hold it for its whole budget).
    static func frontmostPid(_ device: SimDeviceHandle, timeout: TimeInterval) -> Int32? {
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
