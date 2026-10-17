import Foundation
import IOSurface

/// Protocol v1's methods. Each runs under its deadline (DeadlineDispatcher): `hid` on its device's
/// lane in arrival order (InputLanes), the rest on a concurrent work queue. Per-device state lives in
/// the display registry and the lanes, so two devices never wait on each other.
public final class HelperMethods: MethodHandler, @unchecked Sendable {
    private let environment: [String: String]
    private let context: HelperContext
    private let startup: SelftestReport
    private let startupJSON: Data
    let displays = DisplayRegistry<DisplayAttachment>()
    let deviceLocks = DeviceLocks()
    /// `streamEnded` events in the order streams ended, and the detaches they lead to.
    let streamEnds = DispatchQueue(label: "pod-sim.stream-ended", qos: .utility)
    let screenshots = Screenshots()
    // Main-display descriptors by device: a screenshot then costs one remote call instead of a
    // dozen. A proxy whose device shut down or rebooted stops answering and is looked up again.
    let portLock = NSLock()
    var ports: [String: DisplayPort] = [:]
    private let dispatcher = DeadlineDispatcher()
    private let inputLanes: InputLanes
    /// Lanes given up on before the helper asks to be replaced: each keeps a thread stuck in a private call.
    static let recycleAfterAbandonedLanes = 2
    public let events = HelperEvents()
    let inputFallback: PublicInputFallback
    let accessibilityFallback: PublicAccessibilityFallback

    public convenience init(environment: [String: String]) {
        self.init(environment: environment, inputFallback: NoPublicInputFallback(), accessibilityFallback: NoPublicAccessibilityFallback())
    }

    init(
        environment: [String: String], inputFallback: PublicInputFallback, accessibilityFallback: PublicAccessibilityFallback,
        inputLanes: InputLanes = InputLanes()
    ) {
        self.environment = environment
        self.inputFallback = inputFallback
        self.accessibilityFallback = accessibilityFallback
        self.inputLanes = inputLanes
        context = HelperContext.discover(environment: environment)
        startup = SelftestRunner.run(SelftestOptions(environment: environment), context: context)
        startupJSON = (try? WireJSON.encoder.encode(startup)) ?? Data("{}".utf8)
        inputLanes.onWedge = { [weak self] wedge in self?.inputWedged(wedge) }
    }

    /// A device's input stuck in a private call: its connection goes, its next call connects afresh,
    /// and the runtime hears of it (and replaces the helper once stuck threads add up).
    private func inputWedged(_ wedge: LaneWedge) {
        InputSessions.shared.forget(wedge.udid)
        events.emit("inputWedged", InputWedgedEvent(
            udid: wedge.udid, stuckMs: wedge.stuckMs, dropped: wedge.dropped, abandoned: wedge.abandoned,
            recycleAdvised: wedge.abandoned >= Self.recycleAfterAbandonedLanes))
    }

    public func helloResult() -> Data { startupJSON }

    /// For the input and accessibility methods (Input/, Accessibility/).
    var startupReport: SelftestReport { startup }
    var helperContext: HelperContext { context }

    public func detachAll() { displays.detachAll() }

    public func handle(_ request: Request, reply: @escaping @Sendable (Reply) -> Void) -> Bool {
        let deadlineMs = HelperProtocol.deadlinesMs[request.method] ?? 5_000
        // Decoded here, on the stdin reader, so a device's calls keep the order they arrived in; params
        // that do not decode take the common path to their badParams answer.
        if request.method == "hid", case .success(let params) = WireJSON.decode(HIDParams.self, from: request.params),
           UUID(uuidString: params.udid) != nil {
            let call = dispatcher.start("hid", deadlineMs: deadlineMs, reply: reply)
            inputLanes.submit(udid: params.udid.uppercased(), call: call) { self.hid(params) }
            return true
        }
        let run: (@Sendable () -> Reply)?
        switch request.method {
        case "selftest": run = { self.selftest(request.params) }
        case "attachDisplay": run = { self.attachDisplay(request.params) }
        case "displayStats": run = { self.displayStats(request.params) }
        case "detachDisplay": run = { self.detachDisplay(request.params) }
        case "startStream": run = { self.startStream(request.params) }
        case "stopStream": run = { self.stopStream(request.params) }
        case "settle": run = { self.settle(request.params) }
        case "screenshot": run = { self.screenshot(request.params) }
        case "hid": run = { self.hid(request.params) }
        case "ax": run = { self.ax(request.params) }
        default: run = nil
        }
        guard let run else { return false }
        dispatcher.run(request.method, deadlineMs: deadlineMs, run, reply: reply)
        return true
    }

    // MARK: - methods

    private struct SelftestParams: Decodable {
        let udid: String?
        let waitMs: Int?
    }

    private func selftest(_ params: Data) -> Reply {
        decode(SelftestParams.self, params) { params in
            if let udid = params.udid, UUID(uuidString: udid) == nil { return .error(HelperError(.badParams, "udid is not a UUID")) }
            let options = SelftestOptions(udid: params.udid, waitMs: min(max(params.waitMs ?? 1500, 100), 10_000), environment: environment)
            return .encoding(SelftestRunner.run(options, context: context))
        }
    }

    private struct ScreenshotParams: Decodable {
        let udid: String
        let path: String
        let format: ImageFormat?
        let scale: Double?
        let quality: Double?
    }

    private func screenshot(_ params: Data) -> Reply {
        decode(ScreenshotParams.self, params) { params in
            guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
            let scale = params.scale ?? 1, quality = params.quality ?? 0.8
            guard scale > 0, scale <= 1, quality > 0, quality <= 1 else {
                return .error(HelperError(.badParams, "scale and quality must be in (0, 1]"))
            }
            guard params.path.hasPrefix("/") else { return .error(HelperError(.badParams, "path must be absolute")) }
            var isDirectory: ObjCBool = false
            let directory = (params.path as NSString).deletingLastPathComponent
            guard FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory), isDirectory.boolValue else {
                return .error(HelperError(.writeFailed, "no directory \(directory)"))
            }
            let framebuffer: Screenshots.Framebuffer
            if startup.capabilities.screenshot.status == .ok {
                framebuffer = .readable { self.mainSurface(params.udid.uppercased()) }
            } else {
                framebuffer = .off(reason: startup.capabilities.screenshot.reason ?? "screenshot is \(startup.capabilities.screenshot.status.rawValue)")
            }
            let options = ImageOptions(format: params.format ?? .png, scale: scale, quality: quality)
            let taken = screenshots.take(
                udid: params.udid.uppercased(), path: params.path, options: options, framebuffer: framebuffer,
                developerDir: context.facts.xcode?.developerDir, deviceSet: context.deviceSetPath)
            switch taken {
            case .success(let shot): return .encoding(shot)
            case .failure(let error): return .error(error)
            }
        }
    }

    // MARK: - plumbing

    private func mainSurface(_ udid: String) -> Result<IOSurfaceRef, HelperError> {
        // An attachment that still shows this boot holds the surface already: no remote call at all.
        if case .success(let attachment) = currentAttachment(udid), let surface = attachment.currentSurface {
            return .success(surface)
        }
        // The device's state is local to CoreSimulator's client: cheap, and a shut-down device's
        // cached proxy is never read.
        if case .failure(let error) = booted(udid) {
            portLock.withLock { ports[udid] = nil }
            return .failure(error)
        }
        let cached = portLock.withLock { ports[udid] }
        if let cached, let surface = cached.surface() {
            return .success(surface)
        }
        if cached != nil {
            HelperLog.note("screenshot \(udid): the cached display port has no surface; looking it up again")
        }
        portLock.withLock { ports[udid] = nil }
        return booted(udid).flatMap(DisplayPort.main(of:)).flatMap { port in
            guard let surface = port.surface() else { return .failure(HelperError(.failed, "the main display has no surface")) }
            portLock.withLock { ports[udid] = port }
            return .success(surface)
        }
    }

    func isBooted(_ udid: String) -> Bool {
        if case .success = booted(udid) { true } else { false }
    }

    func booted(_ udid: String) -> Result<SimDeviceHandle, HelperError> {
        guard UUID(uuidString: udid) != nil else { return .failure(HelperError(.badParams, "udid is not a UUID")) }
        return context.simulatorService.flatMap { $0.device(udid: udid) }.flatMap { device in
            device.isBooted ? .success(device) : .failure(HelperError(.deviceNotBooted, "\(device.name) (\(device.udid)) is \(device.state), not Booted"))
        }
    }

    func refusal(for report: CapabilityReport, _ capability: Capability) -> HelperError? {
        switch report.status {
        case .ok: nil
        case .unsupported: HelperError(.unsupported, "\(capability.rawValue): \(report.reason ?? "unsupported")")
        case .failed: HelperError(.failed, "\(capability.rawValue): \(report.reason ?? "failed its self-test")")
        }
    }

    func decode<T: Decodable>(_ type: T.Type, _ params: Data, _ body: (T) -> Reply) -> Reply {
        switch WireJSON.decode(type, from: params) {
        case .failure(let error): .error(error)
        case .success(let value): body(value)
        }
    }
}
