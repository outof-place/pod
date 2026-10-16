import Foundation

public struct SelftestOptions: Sendable {
    public var udid: String?
    /// How long the display check waits for its first callback.
    public var waitMs: Int
    public var environment: [String: String]

    public init(udid: String? = nil, waitMs: Int = 1500, environment: [String: String]) {
        self.udid = udid
        self.waitMs = waitMs
        self.environment = environment
    }
}

/// What this helper context found once at start: reused by `hello`, `selftest` and the methods.
public struct HelperContext: Sendable {
    public let facts: EnvironmentFacts
    public let tableSource: VersionTableSource.Loaded
    public let forcedUnknown: Bool
    public let overridePath: String?
    /// `POD_SIM_DEVICE_SET`: a device set other than the default, for probes.
    public let deviceSetPath: String?
    public let lookup: TableLookup?
    /// nil when nothing private was loaded (unknown build, no Xcode).
    public let frameworks: Result<Void, HelperError>?

    public static let deviceSetEnvironmentKey = "POD_SIM_DEVICE_SET"

    public static func discover(environment: [String: String]) -> HelperContext {
        discover(environment: environment, facts: XcodeEnvironmentResolver.resolve(environment: environment), loadFrameworks: PrivateFrameworks.load)
    }

    /// `loadFrameworks` runs only when the table picked an implementation for this build: an unknown
    /// or forced-unknown build never loads private code.
    static func discover(
        environment: [String: String], facts: EnvironmentFacts, loadFrameworks: (EnvironmentFacts) -> Result<Void, HelperError>
    ) -> HelperContext {
        let overridePath = environment[VersionTable.overrideEnvironmentKey].flatMap { $0.isEmpty ? nil : $0 }
        let tableSource = VersionTableSource.load(overridePath: overridePath)
        let forcedUnknown = environment[VersionTable.forceUnknownEnvironmentKey] == "1"
        let lookup = facts.builds.map { tableSource.table.lookup($0, forcedUnknown: forcedUnknown, implemented: SelftestRunner.implemented) }
        let picksAny = lookup?.verdicts.values.contains { if case .implementation = $0 { true } else { false } } ?? false
        return HelperContext(
            facts: facts, tableSource: tableSource, forcedUnknown: forcedUnknown, overridePath: overridePath,
            deviceSetPath: environment[deviceSetEnvironmentKey].flatMap { $0.isEmpty ? nil : $0 },
            lookup: lookup, frameworks: picksAny ? loadFrameworks(facts) : nil)
    }

    var simulatorService: Result<SimulatorService, HelperError> {
        guard let developerDir = facts.xcode?.developerDir, case .success = frameworks else {
            return .failure(HelperError(.unsupported, facts.problem ?? "CoreSimulator is not loaded"))
        }
        return SimulatorService.shared(developerDir: developerDir, deviceSetPath: deviceSetPath)
    }
}

public enum SelftestRunner {
    /// What this binary implements; stage 3 adds `hid` and `ax`.
    public static let implemented: [Capability: Set<String>] = [.display: ["screenCallbacks"], .screenshot: ["surface"]]

    public static func run(_ options: SelftestOptions, context: HelperContext) -> SelftestReport {
        var probes: [Capability: ProbeOutcome] = [:]
        var device: SelftestReport.Device?
        let loadFailure: String? = if case .failure(let error) = context.frameworks { error.message } else { nil }

        if case .success = context.frameworks {
            let missing = PrivateFrameworks.missingSymbols(deviceSetOverride: context.deviceSetPath != nil)
            let symbols: ProbeOutcome = missing.isEmpty
                ? .passed(checked: .symbols, note: nil)
                : .failed(checked: .symbols, reason: "missing \(missing.joined(separator: ", "))")
            probes[.display] = symbols
            probes[.screenshot] = symbols
            if missing.isEmpty, let udid = options.udid {
                switch context.simulatorService.flatMap({ $0.device(udid: udid) }) {
                case .failure(let error):
                    device = SelftestReport.Device(udid: udid, name: nil, state: nil, problem: error.message)
                case .success(let handle):
                    device = SelftestReport.Device(
                        udid: handle.udid, name: handle.name, state: handle.state,
                        problem: handle.isBooted ? nil : "\(handle.state), not Booted: device checks skipped")
                    if handle.isBooted {
                        let display = DeviceProbes.display(handle, waitMs: options.waitMs)
                        probes[.display] = display
                        probes[.screenshot] = DeviceProbes.screenshot(handle)
                    }
                }
            }
        } else if let udid = options.udid {
            device = DeviceProbes.publicDeviceInfo(udid: udid, developerDir: context.facts.xcode?.developerDir, deviceSet: context.deviceSetPath)
        }

        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: context.facts.problem, lookup: context.lookup?.verdicts,
            frameworkLoadFailure: loadFailure, probes: probes))
        let fallbacks = options.udid.map {
            SelftestReport.Fallbacks(screenshot: DeviceProbes.simctlScreenshot(
                udid: $0, developerDir: context.facts.xcode?.developerDir, deviceSet: context.deviceSetPath))
        }
        return SelftestReport(
            protocol: HelperProtocol.version,
            helper: .init(version: HelperVersion.current, pid: Int(getpid())),
            xcode: context.facts.xcode, coreSimulator: context.facts.coreSimulator, simulatorKit: context.facts.simulatorKit,
            problem: context.facts.problem,
            table: .init(
                known: context.lookup?.entry != nil, entry: context.lookup?.entry?.name, source: context.tableSource.source,
                override: context.overridePath, overrideError: context.tableSource.overrideError, forcedUnknown: context.forcedUnknown),
            capabilities: .init(
                display: reports[.display]!, screenshot: reports[.screenshot]!, hid: reports[.hid]!, ax: reports[.ax]!),
            deviceSet: context.deviceSetPath, device: device, fallbacks: fallbacks)
    }
}
