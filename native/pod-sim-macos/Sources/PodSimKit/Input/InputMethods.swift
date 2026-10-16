import Foundation

/// `hid`'s answer.
public struct HIDResult: Codable, Equatable, Sendable {
    public let udid: String
    public let kind: String
    /// Time spent sending, waits included.
    public let ms: Int
    /// How text went in: `hid` (keys) or `paste` (pasteboard plus Cmd+V).
    public let via: String?
    /// Characters of text sent.
    public let typed: Int?
    /// With `waitForFrameMs`: the first frame after the first event, in ms; absent when none came.
    public let frameAfterMs: Double?
    /// Set when a public fallback did the work instead of DTUHID: the version table's reason.
    public var degraded: String?
    /// `pastePermission`: after a paste, iOS took the screen to ask whether the app may paste (an app
    /// not granted `simctl privacy <udid> grant pasteboard <bundle>`); the text lands once "Allow
    /// Paste", which `ax` lists, is tapped.
    public var alert: String? = nil
}

/// Input a public driver performs when the version table has no private path for this build
/// (pre-mortem triage 6). None ships yet: the seam answers why, so a caller sees `unsupported`
/// with the reason rather than a crash or a silent no-op. The seam marks what a fallback answers
/// `degraded` with the table's reason.
protocol PublicInputFallback: Sendable {
    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError>
}

struct NoPublicInputFallback: PublicInputFallback {
    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
        .failure(HelperError(.unsupported, "no public input fallback in this helper (an XCTest driver is owed)"))
    }
}

extension HelperMethods {
    func hid(_ params: Data) -> Reply {
        decode(HIDParams.self, params) { hid($0) }
    }

    /// Runs on the device's lane (InputLanes), so everything here happens in the order calls arrived.
    func hid(_ params: HIDParams) -> Reply {
        guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
        if let wait = params.waitForFrameMs, !(1...2_000).contains(wait) {
            return .error(HelperError(.badParams, "waitForFrameMs must be 1 to 2000"))
        }
        let action: HIDAction
        switch HIDAction.from(params.action) {
        case .failure(let error): return .error(error)
        case .success(let parsed): action = parsed
        }
        // A paste's answer waits on the app (the Allow Paste watch): no input-to-frame time to report.
        if params.waitForFrameMs != nil, case .text(let text, let via) = action, case .success(.paste) = TextRoute.choose(text, via: via) {
            return .error(HelperError(.badParams, "waitForFrameMs times taps, keys and buttons, not text that goes in by paste"))
        }
        // Before any device lookup: with the table unknown CoreSimulator is not even loaded.
        if let refused = refusal(for: startupReport.capabilities.hid, .hid) {
            switch inputFallback.hid(action, udid: params.udid.uppercased()) {
            case .success(var result):
                result.degraded = refused.message
                return .encoding(result)
            case .failure(let error):
                return .error(HelperError(refused.code, "\(refused.message); \(error.message)"))
            }
        }
        let device: SimDeviceHandle
        switch booted(params.udid.uppercased()) {
        case .failure(let error): return .error(error)
        case .success(let found): device = found
        }
        return InputRun.perform(
            action, device: device, waitForFrameMs: params.waitForFrameMs, context: helperContext,
            watchPasteAlert: startupReport.capabilities.ax.status == .ok)
    }
}

/// One `hid` call against a booted device on the private path, within `worstCaseSeconds`.
enum InputRun {
    static let barrierTimeout: TimeInterval = 2
    /// The app that pasted, read before Cmd+V so the alert watch can see SpringBoard take over.
    static let appBeforePasteTimeout: TimeInterval = 1

    /// Once a call runs: connecting, then an action or a paste, then the barrier. The frame wait counts
    /// from the first event, so it ends inside an action's time (2 s at most against 8 s) and a paste
    /// refuses it. `hid`'s deadline must cover both routes.
    static var worstCaseSeconds: (action: TimeInterval, paste: TimeInterval) {
        let connect = DTUHIDTransport.livenessTimeout + Double(DTUHIDTransport.replyTailMs) / 1_000
        let action = Double(HIDLimits.plannedMaxMs) / 1_000
        let paste = Pasteboard.timeout + Subprocess.terminateGrace + appBeforePasteTimeout
            + HIDPlan.plannedMs(HIDPlan.paste) / 1_000 + PasteAlert.worstCaseSeconds
        return (connect + action + barrierTimeout, connect + paste + barrierTimeout)
    }

    static func perform(
        _ action: HIDAction, device: SimDeviceHandle, waitForFrameMs: Int?, context: HelperContext, watchPasteAlert: Bool
    ) -> Reply {
        let screen = DeviceScreen.of(device).points
        guard screen.width > 0, screen.height > 0 else { return .error(HelperError(.failed, "\(device.name) reports no screen size")) }
        if let outside = HIDPlan.outside(action, screen: screen) {
            return .error(HelperError(.badParams, "(\(outside.x), \(outside.y)) is outside the \(Int(screen.width))x\(Int(screen.height))-point screen"))
        }
        if let refused = OrientationGate.refusal(action, orientation: DeviceOrientations.shared.latest(device)) {
            return .error(refused)
        }
        var via: String?
        var typed: Int?
        var steps: [HIDStep]
        var pasteText: String?
        if case .text(let text, let requested) = action {
            switch TextRoute.choose(text, via: requested) {
            case .failure(let error): return .error(error)
            case .success(.keys):
                steps = HIDPlan.typing(text)
                via = "hid"
            case .success(.paste):
                steps = HIDPlan.paste
                pasteText = text
                via = "paste"
            }
            typed = text.count
        } else {
            steps = HIDPlan.steps(action, screen: screen)
        }
        if HIDPlan.plannedMs(steps) > Double(HIDLimits.plannedMaxMs) {
            return .error(HelperError(.badParams, "the \(action.kind) would take over \(HIDLimits.plannedMaxMs) ms"))
        }
        let started = DispatchTime.now()
        let session: InputSessions.Session
        switch InputSessions.shared.session(for: device) {
        case .failure(let error): return .error(error)
        case .success(let found): session = found
        }
        var appBeforePaste: Int32?
        if let pasteText {
            if case .failure(let error) = Pasteboard.copy(pasteText, udid: device.udid, context: context) { return .error(error) }
            if watchPasteAlert { appBeforePaste = AccessibilitySnapshots.frontmostPid(device, timeout: appBeforePasteTimeout) }
        }
        var waiter: FrameWaiter?
        if waitForFrameMs != nil {
            switch FrameWaiter.start(device) {
            case .failure(let error): return .error(HelperError(error.code, "waitForFrameMs: \(error.message)"))
            case .success(let started): waiter = started
            }
        }
        let sent = InputSessions.shared.run(steps, on: session, onFirstSend: { waiter?.arm() })
        if case .failure(let error) = sent {
            waiter?.cancel()
            InputSessions.shared.discard(session)
            return .error(error)
        }
        // Everything sent has reached dtuhidd once a barrier comes back; a silent daemon means the
        // connection is dead, and the next call reconnects.
        guard session.transport.barrier(timeout: barrierTimeout) else {
            waiter?.cancel()
            InputSessions.shared.discard(session)
            return .error(HelperError(.failed, "dtuhidd in \(device.name) stopped answering; the next call reconnects"))
        }
        let frameAfterMs = waitForFrameMs.flatMap { waiter?.wait(limitMs: $0) }
        let alert = appBeforePaste.flatMap { PasteAlert.watch(device, appBefore: $0) }
        let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
        var result = HIDResult(
            udid: device.udid, kind: action.kind, ms: ms, via: via, typed: typed, frameAfterMs: frameAfterMs, degraded: nil)
        result.alert = alert
        return .encoding(result)
    }
}

/// iOS's "Allow Paste" prompt is SpringBoard's: the frontmost application changes from the app that
/// pasted while it is up (the accessibility tree lists its buttons; seen 2026-10-16 on iOS 26.5).
enum PasteAlert {
    static let watchMs = 600
    static let pollMs = 100
    static let pollTimeout: TimeInterval = 0.5
    /// A poll that starts just before the watch ends, then its pause.
    static var worstCaseSeconds: TimeInterval { Double(watchMs + pollMs) / 1_000 + pollTimeout }

    static func watch(_ device: SimDeviceHandle, appBefore: Int32) -> String? {
        let end = DispatchTime.now() + .milliseconds(watchMs)
        while DispatchTime.now() < end {
            if let now = AccessibilitySnapshots.frontmostPid(device, timeout: pollTimeout), now != appBefore { return "pastePermission" }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1_000)
        }
        return nil
    }
}

/// The device's pasteboard through `simctl pbcopy` (public; UTF-8 on stdin).
enum Pasteboard {
    /// pbcopy answers in well under a second; a CoreSimulatorService that stalls longer fails the
    /// call before anything is sent.
    static let timeout: TimeInterval = 2.5

    /// `simctl pbcopy` decodes stdin in the locale's encoding: without one (Pod started from Finder has
    /// no LANG) "zażółć" lands as MacRoman mojibake (seen 2026-10-16).
    static func environment(_ base: [String: String]) -> [String: String] {
        base.merging(["LC_ALL": "en_US.UTF-8"]) { _, utf8 in utf8 }
    }

    static func copy(_ text: String, udid: String, context: HelperContext) -> Result<Void, HelperError> {
        let arguments = SimctlScreenshot.simctl(deviceSet: context.deviceSetPath) + ["pbcopy", udid]
        let run = Subprocess.run(
            "/usr/bin/xcrun", arguments, environment: environment(SimctlScreenshot.environment(context.facts.xcode?.developerDir)),
            timeout: timeout, input: Data(text.utf8))
        switch run {
        case .success: return .success(())
        case .failure(let failure): return .failure(HelperError(.simctlFailed, "simctl pbcopy \(failure.text)"))
        }
    }
}
