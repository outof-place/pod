import Foundation
import IOSurface

public struct ScreenshotResult: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable { case surface, simctl }

    public let path: String
    public let format: ImageFormat
    public let width: Int
    public let height: Int
    public let bytes: Int
    public let source: Source
    public let ms: Int
    /// Why the framebuffer path was not used, when `source` is `simctl`.
    public let fallbackReason: String?
}

/// The framebuffer when the self-test allows it, `simctl io screenshot` (public) otherwise or when
/// the framebuffer read fails: a screenshot keeps working on a build the version table does not know.
final class Screenshots: @unchecked Sendable {
    private let writer = ImageWriter()

    enum Framebuffer {
        case readable(() -> Result<IOSurfaceRef, HelperError>)
        /// The self-test did not allow it; the reason travels with a `simctl` result.
        case off(reason: String)
    }

    func take(
        udid: String, path: String, options: ImageOptions, framebuffer: Framebuffer, developerDir: String?, deviceSet: String?
    ) -> Result<ScreenshotResult, HelperError> {
        let started = DispatchTime.now()
        let fallbackReason: String
        switch framebuffer {
        case .off(let reason):
            fallbackReason = reason
        case .readable(let surface):
            switch surface().flatMap({ writer.write(surface: $0, to: path, options) }) {
            case .success(let image):
                return .success(result(path, options, image, .surface, started, nil))
            case .failure(let error) where [HelperErrorCode.writeFailed, .deviceNotFound, .deviceNotBooted].contains(error.code):
                return .failure(error)
            case .failure(let error):
                fallbackReason = error.message
            }
        }
        return simctl(udid: udid, path: path, options: options, developerDir: developerDir, deviceSet: deviceSet).map {
            result(path, options, $0, .simctl, started, fallbackReason)
        }
    }

    private func simctl(udid: String, path: String, options: ImageOptions, developerDir: String?, deviceSet: String?) -> Result<WrittenImage, HelperError> {
        let raw = FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-\(getpid())-\(UUID().uuidString.prefix(8)).png")
        defer { try? FileManager.default.removeItem(at: raw) }
        switch SimctlScreenshot.capture(udid: udid, to: raw.path, developerDir: developerDir, deviceSet: deviceSet) {
        case .failure(let error): return .failure(error)
        case .success: return writer.write(contentsOf: raw, to: path, options)
        }
    }

    private func result(
        _ path: String, _ options: ImageOptions, _ image: WrittenImage, _ source: ScreenshotResult.Source,
        _ started: DispatchTime, _ fallbackReason: String?
    ) -> ScreenshotResult {
        let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
        return ScreenshotResult(
            path: path, format: options.format, width: image.width, height: image.height, bytes: image.bytes,
            source: source, ms: ms, fallbackReason: fallbackReason)
    }
}

enum SimctlScreenshot {
    /// `xcrun simctl io <udid> screenshot --type=png --mask=ignored <path>` (flags from `simctl io help`
    /// on Xcode 27): unmasked, like the framebuffer path, so both give the same pixels.
    static func capture(udid: String, to path: String, developerDir: String?, deviceSet: String?) -> Result<Void, HelperError> {
        let run = Subprocess.run(
            "/usr/bin/xcrun", simctl(deviceSet: deviceSet) + ["io", udid, "screenshot", "--type=png", "--mask=ignored", path],
            environment: environment(developerDir), timeout: HelperProtocol.simctlTimeout)
        switch run {
        case .success: return .success(())
        case .failure(let failure): return .failure(HelperError(.simctlFailed, "simctl io screenshot \(failure.text)"))
        }
    }

    static func simctl(deviceSet: String?) -> [String] {
        ["simctl"] + (deviceSet.map { ["--set", $0] } ?? [])
    }

    /// The helper's environment without its token or any `POD_SIM_*` setting: simctl needs neither.
    static func environment(_ developerDir: String?, base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = base.filter { !$0.key.hasPrefix("POD_SIM_") }
        if let developerDir { environment["DEVELOPER_DIR"] = developerDir }
        return environment
    }
}
