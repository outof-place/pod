import Foundation

/// How far a check got: decided by the table alone, frameworks loaded and symbols resolved, a booted
/// device's surface without a frame (`display` only: the screen did not change while the check
/// waited, so nothing proved a live view), or a booted device end to end. `display` ok at `device`
/// means frame callbacks arrived.
public enum CheckLevel: String, CaseIterable, Codable, Sendable {
    case table, symbols, surfaceOnly, device
}

public enum ProbeOutcome: Equatable, Sendable {
    case passed(checked: CheckLevel, note: String?, framesSeen: Int? = nil)
    case failed(checked: CheckLevel, reason: String)
}

public struct CapabilityReport: Codable, Equatable, Sendable {
    public let status: Verdict
    public let implementation: String?
    public let checked: CheckLevel
    public let reason: String?
    public let note: String?
    /// `display` checked on a device: frame callbacks seen while the self-test waited.
    public var framesSeen: Int? = nil
}

public struct VerdictInputs: Sendable {
    public var environmentProblem: String?
    public var lookup: [Capability: TableVerdict]?
    public var frameworkLoadFailure: String?
    public var probes: [Capability: ProbeOutcome]
}

/// The order is the rule: no Xcode, then the table, then loading, then what the probe saw.
public enum SelftestVerdicts {
    public static func compose(_ inputs: VerdictInputs) -> [Capability: CapabilityReport] {
        var reports: [Capability: CapabilityReport] = [:]
        for capability in Capability.allCases {
            reports[capability] = verdict(for: capability, inputs)
        }
        return reports
    }

    private static func verdict(for capability: Capability, _ inputs: VerdictInputs) -> CapabilityReport {
        if let problem = inputs.environmentProblem {
            return CapabilityReport(status: .unsupported, implementation: nil, checked: .table, reason: problem, note: nil)
        }
        switch inputs.lookup?[capability] ?? .unsupported("not in the version table") {
        case .unsupported(let reason):
            return CapabilityReport(status: .unsupported, implementation: nil, checked: .table, reason: reason, note: nil)
        case .implementation(let name):
            if let failure = inputs.frameworkLoadFailure {
                return CapabilityReport(status: .failed, implementation: name, checked: .symbols, reason: failure, note: nil)
            }
            switch inputs.probes[capability] {
            case .passed(let checked, let note, let framesSeen):
                return CapabilityReport(status: .ok, implementation: name, checked: checked, reason: nil, note: note, framesSeen: framesSeen)
            case .failed(let checked, let reason):
                return CapabilityReport(status: .failed, implementation: name, checked: checked, reason: reason, note: nil)
            case nil:
                return CapabilityReport(status: .failed, implementation: name, checked: .table, reason: "not checked", note: nil)
            }
        }
    }
}
