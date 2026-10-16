import Foundation

public enum HelperVersion {
    public static let current = "0.1.0"
}

/// `hello`'s result and `pod-sim --selftest --json`: what the helper found, what its version table
/// says about it, and each capability's verdict. Keys absent when unknown, never null.
public struct SelftestReport: Codable, Equatable, Sendable {
    public struct Helper: Codable, Equatable, Sendable {
        public let version: String
        public let pid: Int
    }

    public struct Table: Codable, Equatable, Sendable {
        public let known: Bool
        public let entry: String?
        public let source: VersionTableSource.Origin
        public let override: String?
        public let overrideError: String?
        public let forcedUnknown: Bool
    }

    public struct Capabilities: Codable, Equatable, Sendable {
        public let display: CapabilityReport
        public let screenshot: CapabilityReport
        public let hid: CapabilityReport
        public let ax: CapabilityReport

        public subscript(capability: Capability) -> CapabilityReport {
            switch capability {
            case .display: display
            case .screenshot: screenshot
            case .hid: hid
            case .ax: ax
            }
        }
    }

    public struct Device: Codable, Equatable, Sendable {
        public let udid: String
        public let name: String?
        public let state: String?
        /// Why the device checks did not run (not found, not booted); capabilities stay at `symbols`.
        public let problem: String?
    }

    public struct Fallback: Codable, Equatable, Sendable {
        public let via: String
        public let status: Verdict
        public let ms: Int?
        public let reason: String?
    }

    public struct Fallbacks: Codable, Equatable, Sendable {
        public let screenshot: Fallback
    }

    public let `protocol`: Int
    public let helper: Helper
    public let xcode: XcodeInfo?
    public let coreSimulator: FrameworkInfo?
    public let simulatorKit: FrameworkInfo?
    /// Set when no usable Xcode, CoreSimulator or SimulatorKit was found.
    public let problem: String?
    public let table: Table
    public let capabilities: Capabilities
    /// Set when `POD_SIM_DEVICE_SET` points the helper at a device set other than the default.
    public let deviceSet: String?
    public let device: Device?
    public let fallbacks: Fallbacks?
}
