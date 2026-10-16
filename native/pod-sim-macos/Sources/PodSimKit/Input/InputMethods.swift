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
    /// Set when a public fallback did the work instead of DTUHID, and why.
    public let degraded: String?
    /// `pastePermission`: after a paste, iOS took the screen to ask whether the app may paste (an app
    /// not granted `simctl privacy <udid> grant pasteboard <bundle>`); the text lands once "Allow
    /// Paste", which `ax` lists, is tapped.
    public var alert: String? = nil
}

/// Input a public driver performs when the version table has no private path for this build
/// (pre-mortem triage 6). None ships yet: the seam answers why, so a caller sees `unsupported`
/// with the reason rather than a crash or a silent no-op.
protocol PublicInputFallback: Sendable {
    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError>
}

struct NoPublicInputFallback: PublicInputFallback {
    func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
        .failure(HelperError(.unsupported, "no public input fallback in this helper (an XCTest driver is owed)"))
    }
}

extension HelperMethods {
    func hid(_ params: Data, fallback: PublicInputFallback = NoPublicInputFallback()) -> Reply {
        decode(HIDParams.self, params) { params in
            guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
            if let wait = params.waitForFrameMs, !(1...2_000).contains(wait) {
                return .error(HelperError(.badParams, "waitForFrameMs must be 1 to 2000"))
            }
            let action: HIDAction
            switch HIDAction.from(params.action) {
            case .failure(let error): return .error(error)
            case .success(let parsed): action = parsed
            }
            // Before any device lookup: with the table unknown CoreSimulator is not even loaded.
            if let refused = refusal(for: startupReport.capabilities.hid, .hid) {
                switch fallback.hid(action, udid: params.udid.uppercased()) {
                case .success(let result): return .encoding(result)
                case .failure(let error): return .error(HelperError(refused.code, "\(refused.message); \(error.message)"))
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
}

/// One `hid` call against a booted device on the private path.
enum InputRun {
    static func perform(
        _ action: HIDAction, device: SimDeviceHandle, waitForFrameMs: Int?, context: HelperContext, watchPasteAlert: Bool
    ) -> Reply {
        let screen = DeviceScreen.of(device).points
        guard screen.width > 0, screen.height > 0 else { return .error(HelperError(.failed, "\(device.name) reports no screen size")) }
        if let outside = HIDPlan.outside(action, screen: screen) {
            return .error(HelperError(.badParams, "(\(outside.x), \(outside.y)) is outside the \(Int(screen.width))x\(Int(screen.height))-point screen"))
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
            if HIDPlan.plannedMs(steps) > Double(HIDLimits.plannedMaxMs) {
                return .error(HelperError(.badParams, "the \(action.kind) would take over \(HIDLimits.plannedMaxMs) ms"))
            }
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
            if watchPasteAlert { appBeforePaste = AccessibilitySnapshots.frontmostPid(device, timeout: 1) }
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
        guard session.queue.sync(execute: { session.transport.barrier(timeout: 2) }) else {
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

    static func watch(_ device: SimDeviceHandle, appBefore: Int32) -> String? {
        let end = DispatchTime.now() + .milliseconds(watchMs)
        while DispatchTime.now() < end {
            if let now = AccessibilitySnapshots.frontmostPid(device, timeout: 0.5), now != appBefore { return "pastePermission" }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1_000)
        }
        return nil
    }
}

/// The device's pasteboard through `simctl pbcopy` (public; UTF-8 on stdin).
enum Pasteboard {
    /// `simctl pbcopy` decodes stdin in the locale's encoding: without one (Pod started from Finder has
    /// no LANG) "zażółć" lands as MacRoman mojibake (seen 2026-10-16).
    static func environment(_ base: [String: String]) -> [String: String] {
        base.merging(["LC_ALL": "en_US.UTF-8"]) { _, utf8 in utf8 }
    }

    static func copy(_ text: String, udid: String, context: HelperContext) -> Result<Void, HelperError> {
        let arguments = SimctlScreenshot.simctl(deviceSet: context.deviceSetPath) + ["pbcopy", udid]
        let run = Subprocess.run(
            "/usr/bin/xcrun", arguments, environment: environment(SimctlScreenshot.environment(context.facts.xcode?.developerDir)),
            timeout: HelperProtocol.simctlTimeout, input: Data(text.utf8))
        switch run {
        case .success: return .success(())
        case .failure(let failure): return .failure(HelperError(.simctlFailed, "simctl pbcopy \(failure.text)"))
        }
    }
}
