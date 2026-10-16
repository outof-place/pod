import Foundation

/// CFBundleVersion of the two private frameworks the table is keyed by.
public struct FrameworkBuilds: Equatable, Sendable {
    public let coreSimulator: String
    public let simulatorKit: String

    public init(coreSimulator: String, simulatorKit: String) {
        self.coreSimulator = coreSimulator
        self.simulatorKit = simulatorKit
    }
}

public enum TableVerdict: Equatable, Sendable {
    case implementation(String)
    case unsupported(String)
}

public struct TableLookup: Sendable {
    public let entry: VersionTable.Entry?
    public let verdicts: [Capability: TableVerdict]
}

public struct VersionTableError: Error, Equatable, Sendable {
    public let message: String
}

/// Picks the implementation per capability for an exact (CoreSimulator, SimulatorKit) build pair.
/// Exact on purpose: Apple moves private symbols between point releases, so a new build is
/// unsupported until a row says otherwise, and the public fallbacks carry on meanwhile.
public struct VersionTable: Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let name: String
        public let coreSimulator: String
        public let simulatorKit: String
        public let capabilities: [String: String]
        public let verified: String?
    }

    public static let schema = 1
    public static let forceUnknownEnvironmentKey = "POD_SIM_FORCE_UNKNOWN_BUILD"
    public static let overrideEnvironmentKey = "POD_SIM_VERSION_TABLE"

    public let entries: [Entry]

    public static func bundled() throws -> VersionTable {
        try decode(Data(bundledVersionTableJSON.utf8))
    }

    private struct File: Decodable {
        let schema: Int
        let builds: [Entry]
    }

    public static func decode(_ data: Data) throws -> VersionTable {
        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw VersionTableError(message: "not a version table: \(error.localizedDescription)")
        }
        guard file.schema == schema else {
            throw VersionTableError(message: "schema \(file.schema), this helper reads schema \(schema)")
        }
        return VersionTable(entries: file.builds)
    }

    /// The override's rows replace rows for the same builds and come first; the rest stay.
    public func overlaid(by override: VersionTable) -> VersionTable {
        let replaced = Set(override.entries.map { "\($0.coreSimulator)|\($0.simulatorKit)" })
        return VersionTable(entries: override.entries + entries.filter { !replaced.contains("\($0.coreSimulator)|\($0.simulatorKit)") })
    }

    /// `implemented`: the implementation names this binary has, per capability.
    public func lookup(_ builds: FrameworkBuilds, forcedUnknown: Bool, implemented: [Capability: Set<String>]) -> TableLookup {
        let entry = forcedUnknown
            ? nil
            : entries.first { $0.coreSimulator == builds.coreSimulator && $0.simulatorKit == builds.simulatorKit }
        var verdicts: [Capability: TableVerdict] = [:]
        for capability in Capability.allCases {
            let ours = implemented[capability] ?? []
            if ours.isEmpty {
                verdicts[capability] = .unsupported("not in this helper yet")
            } else if forcedUnknown {
                verdicts[capability] = .unsupported("treated as unknown (\(Self.forceUnknownEnvironmentKey)=1)")
            } else if let entry {
                if let name = entry.capabilities[capability.rawValue] {
                    verdicts[capability] = ours.contains(name)
                        ? .implementation(name)
                        : .unsupported("this helper has no \(capability.rawValue) implementation named \(name)")
                } else {
                    verdicts[capability] = .unsupported("not supported with CoreSimulator \(builds.coreSimulator) and SimulatorKit \(builds.simulatorKit)")
                }
            } else {
                verdicts[capability] = .unsupported("CoreSimulator \(builds.coreSimulator) with SimulatorKit \(builds.simulatorKit) is not in the version table")
            }
        }
        return TableLookup(entry: entry, verdicts: verdicts)
    }
}

public enum VersionTableSource {
    public enum Origin: String, Codable, Sendable { case bundled, override }

    public struct Loaded: Sendable {
        public let table: VersionTable
        public let source: Origin
        public let overrideError: String?
    }

    /// The bundled table, overlaid by the file at `overridePath` when it reads; an unreadable
    /// override is reported and ignored, never fatal.
    public static func load(overridePath: String?) -> Loaded {
        // The bundled JSON is a literal in this binary and covered by tests; failing it is a build bug.
        let bundled = (try? VersionTable.bundled()) ?? VersionTable(entries: [])
        guard let overridePath, !overridePath.isEmpty else {
            return Loaded(table: bundled, source: .bundled, overrideError: nil)
        }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: overridePath))
            let override = try VersionTable.decode(data)
            return Loaded(table: bundled.overlaid(by: override), source: .override, overrideError: nil)
        } catch let error as VersionTableError {
            return Loaded(table: bundled, source: .bundled, overrideError: "\(overridePath): \(error.message)")
        } catch {
            return Loaded(table: bundled, source: .bundled, overrideError: "\(overridePath): \(error.localizedDescription)")
        }
    }
}
