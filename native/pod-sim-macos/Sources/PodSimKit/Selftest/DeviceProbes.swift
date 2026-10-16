import Foundation
import IOSurface

/// The self-test's checks against a booted device. Nothing here changes the device: callbacks are
/// registered and removed, and screenshots go to a temporary file that is deleted.
enum DeviceProbes {
    static func display(_ device: SimDeviceHandle, waitMs: Int) -> ProbeOutcome {
        let port: DisplayPort
        switch DisplayPort.main(of: device) {
        case .failure(let error): return .failed(checked: .device, reason: error.message)
        case .success(let found): port = found
        }
        let attachment = DisplayAttachment(port: port)
        if case .failure(let error) = attachment.start() { return .failed(checked: .device, reason: error.message) }
        let deadline = DispatchTime.now() + .milliseconds(waitMs)
        var stats = attachment.stats()
        // A frame, not the surface callback registration sends at once, is what proves a live view.
        while stats.frameCallbacks == 0, DispatchTime.now() < deadline {
            usleep(20_000)
            stats = attachment.stats()
        }
        let surface = attachment.currentSurface
        stats = attachment.stop()
        let size = surface.map { "\(IOSurfaceGetWidth($0))x\(IOSurfaceGetHeight($0))" }
        return displayOutcome(stats, surfaceSize: size, waitMs: waitMs, selection: port.selection)
    }

    /// `device` only when frames arrived; a surface on a screen that did not change while the check
    /// waited is `surfaceOnly`, which stages 2b and 4 never take for a live view.
    static func displayOutcome(_ stats: DisplayStats, surfaceSize: String?, waitMs: Int, selection: String) -> ProbeOutcome {
        let seen = "\(stats.surfaceCallbacks) surface and \(stats.frameCallbacks) frame callbacks in \(Int(stats.seconds * 1000)) ms"
        guard stats.frameCallbacks + stats.surfaceCallbacks > 0 else {
            return .failed(checked: .device, reason: "no screen callback within \(waitMs) ms (surface \(surfaceSize ?? "none"))")
        }
        guard let surfaceSize else { return .failed(checked: .device, reason: "callbacks came but no surface: \(seen)") }
        guard stats.frameCallbacks > 0 else {
            return .passed(
                checked: .surfaceOnly,
                note: "surface \(surfaceSize), \(seen): the screen did not change, so no frame proved a live view; \(selection)",
                framesSeen: 0)
        }
        return .passed(checked: .device, note: "surface \(surfaceSize), \(seen); \(selection)", framesSeen: stats.frameCallbacks)
    }

    /// Unique per call: two self-tests at once (hello's and a `selftest`, or two runtimes) never collide.
    static func temporaryImagePath(_ tag: String) -> String {
        FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-\(tag)-\(getpid())-\(UUID().uuidString).png").path
    }

    static func screenshot(_ device: SimDeviceHandle) -> ProbeOutcome {
        let path = temporaryImagePath("selftest")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let started = DispatchTime.now()
        let written = DisplayPort.main(of: device).flatMap { port -> Result<WrittenImage, HelperError> in
            guard let surface = port.surface() else { return .failure(HelperError(.failed, "the main display has no surface")) }
            return ImageWriter().write(surface: surface, to: path, ImageOptions(format: .png, scale: 1, quality: 1))
        }
        let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
        switch written {
        case .failure(let error): return .failed(checked: .device, reason: error.message)
        case .success(let image) where image.bytes == 0: return .failed(checked: .device, reason: "an empty PNG")
        case .success(let image): return .passed(checked: .device, note: "\(image.width)x\(image.height) PNG, \(image.bytes) bytes in \(ms) ms")
        }
    }

    static func simctlScreenshot(udid: String, developerDir: String?, deviceSet: String?) -> SelftestReport.Fallback {
        let path = temporaryImagePath("selftest-simctl")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let started = DispatchTime.now()
        let result = SimctlScreenshot.capture(udid: udid, to: path, developerDir: developerDir, deviceSet: deviceSet)
        let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        switch result {
        case .failure(let error): return .init(via: "simctl", status: .failed, ms: ms, reason: error.message)
        case .success where bytes == 0: return .init(via: "simctl", status: .failed, ms: ms, reason: "simctl wrote no image")
        case .success: return .init(via: "simctl", status: .ok, ms: ms, reason: nil)
        }
    }

    /// Name and state through `simctl list` when no private framework is loaded.
    static func publicDeviceInfo(udid: String, developerDir: String?, deviceSet: String?) -> SelftestReport.Device {
        let arguments = SimctlScreenshot.simctl(deviceSet: deviceSet) + ["list", "devices", "-j"]
        switch Subprocess.run("/usr/bin/xcrun", arguments, environment: SimctlScreenshot.environment(developerDir), timeout: HelperProtocol.simctlTimeout) {
        case .failure(let failure):
            return .init(udid: udid, name: nil, state: nil, problem: "simctl list \(failure.text)")
        case .success(let output):
            let root = (try? JSONSerialization.jsonObject(with: output.stdout)) as? [String: Any]
            let runtimes = root?["devices"] as? [String: [[String: Any]]] ?? [:]
            guard let found = runtimes.values.joined().first(where: { ($0["udid"] as? String) == udid.uppercased() }) else {
                return .init(udid: udid, name: nil, state: nil, problem: "no simulator \(udid) in simctl list")
            }
            return .init(udid: udid.uppercased(), name: found["name"] as? String, state: found["state"] as? String, problem: nil)
        }
    }
}
