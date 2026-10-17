import Foundation

public struct FrameworkInfo: Codable, Equatable, Sendable {
    public let path: String
    public let version: String
    public let build: String
}

public struct XcodeInfo: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable {
        case developerDir = "DEVELOPER_DIR"
        case xcodeSelect = "xcode-select"
        /// Found in /Applications or ~/Applications, after DEVELOPER_DIR and xcode-select had no row.
        case installed
    }

    public let developerDir: String
    public let source: Source
    public let version: String?
    public let build: String?
    /// Why this Xcode was chosen.
    public var chosenBecause: String? = nil
    /// Every Xcode looked at, in order, when the first one was not taken.
    public var candidates: [XcodeCandidate]? = nil
}

/// One Xcode the helper looked at, and whether the version table has a row for its SimulatorKit.
public struct XcodeCandidate: Codable, Equatable, Sendable {
    public let developerDir: String
    public let source: XcodeInfo.Source
    public let version: String?
    public let build: String?
    /// SimulatorKit's CFBundleVersion.
    public let simulatorKit: String?
    public let known: Bool
    /// Why it cannot be used at all (no SimulatorKit, the Command Line Tools).
    public let problem: String?
}

/// What the helper found before loading anything private: versions come from Info.plists, so an
/// unknown build is reported without ever running its code.
public struct EnvironmentFacts: Sendable {
    public var xcode: XcodeInfo?
    public var coreSimulator: FrameworkInfo?
    public var simulatorKit: FrameworkInfo?
    public var problem: String?
    /// The running macOS, reported for information.
    public var macOS: MacOSInfo?
    /// The translator `ax` runs, which ships with macOS: its build keys `ax` in the version table.
    public var accessibilityTranslation: FrameworkInfo?

    public var builds: FrameworkBuilds? {
        guard problem == nil, let coreSimulator, let simulatorKit else { return nil }
        return FrameworkBuilds(coreSimulator: coreSimulator.build, simulatorKit: simulatorKit.build)
    }
}

/// Picks the Xcode whose SimulatorKit build has a version-table row, in this order: DEVELOPER_DIR,
/// `xcode-select -p`, then the other Xcodes in /Applications and ~/Applications, newest first. A Pod
/// started from the Dock has no DEVELOPER_DIR, and xcode-select may name an Xcode the table does not
/// know while a known one sits beside it. With no known one, the first candidate stays (unknown, so
/// nothing private loads). Never changes the selection itself (no `xcode-select -s`).
public enum XcodeEnvironmentResolver {
    /// System-wide, installed by Xcode's first launch; Xcode 27's own `simctl` wrapper reads this path.
    static let coreSimulatorPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework"
    static let xcodeBundleID = "com.apple.dt.Xcode"

    /// Where the resolver looks: xcode-select, the installed Xcodes (developer dirs) and CoreSimulator.
    public struct Discovery: Sendable {
        var xcodeSelect: @Sendable () -> Result<String, Subprocess.Failure>
        var installed: @Sendable (_ home: String?) -> [String]
        var coreSimulatorPath = XcodeEnvironmentResolver.coreSimulatorPath

        public static let live = Discovery(
            xcodeSelect: XcodeEnvironmentResolver.xcodeSelectPath,
            installed: { home in
                XcodeEnvironmentResolver.installedXcodes(in: ["/Applications"] + (home.map { [($0 as NSString).appendingPathComponent("Applications")] } ?? []))
            })
    }

    public static func resolve(
        environment: [String: String], isKnown: (FrameworkBuilds) -> Bool = { _ in true }, discovery: Discovery = .live
    ) -> EnvironmentFacts {
        var facts = EnvironmentFacts()
        facts.macOS = MacOSInfo.running()
        facts.accessibilityTranslation = framework(at: MacOSInfo.accessibilityTranslationPath)
        let coreSimulator = framework(at: discovery.coreSimulatorPath)

        var looked: [Looked] = []
        func consider(_ path: String, _ source: XcodeInfo.Source) {
            let developerDir = normalized(path)
            guard !looked.contains(where: { $0.info.developerDir == developerDir }) else { return }
            looked.append(examine(developerDir, source: source, coreSimulator: coreSimulator, isKnown: isKnown))
        }
        var selectProblem: String?
        if let fromEnv = environment["DEVELOPER_DIR"], !fromEnv.isEmpty { consider(fromEnv, .developerDir) }
        if !looked.contains(where: \.known) {
            switch discovery.xcodeSelect() {
            case .success(let path): consider(path, .xcodeSelect)
            case .failure(let problem): selectProblem = problem.text
            }
        }
        if !looked.contains(where: \.known) {
            for path in discovery.installed(environment["HOME"]) { consider(path, .installed) }
        }
        guard let first = looked.first else {
            facts.problem = selectProblem ?? "no Xcode: nothing in DEVELOPER_DIR, xcode-select or /Applications"
            return facts
        }
        let chosen = looked.first(where: \.known) ?? first
        var info = chosen.info
        info.chosenBecause = reason(chosen: chosen, first: first, looked: looked)
        if chosen.info.developerDir != first.info.developerDir || looked.count > 1 {
            info.candidates = looked.map(\.candidate)
        }
        facts.xcode = info
        facts.coreSimulator = chosen.coreSimulator
        facts.simulatorKit = chosen.simulatorKit
        facts.problem = chosen.problem
        return facts
    }

    private struct Looked {
        let info: XcodeInfo
        let coreSimulator: FrameworkInfo?
        let simulatorKit: FrameworkInfo?
        let problem: String?
        let known: Bool

        var candidate: XcodeCandidate {
            XcodeCandidate(
                developerDir: info.developerDir, source: info.source, version: info.version, build: info.build,
                simulatorKit: simulatorKit?.build, known: known, problem: problem)
        }

        var name: String { "Xcode \(info.version ?? "?") (\(info.build ?? "?"))" }
    }

    private static func examine(
        _ developerDir: String, source: XcodeInfo.Source, coreSimulator: FrameworkInfo?, isKnown: (FrameworkBuilds) -> Bool
    ) -> Looked {
        let version = NSDictionary(contentsOfFile: (developerDir as NSString).deletingLastPathComponent + "/version.plist")
        let info = XcodeInfo(
            developerDir: developerDir, source: source,
            version: version?["CFBundleShortVersionString"] as? String, build: version?["ProductBuildVersion"] as? String)
        func unusable(_ problem: String) -> Looked {
            Looked(info: info, coreSimulator: coreSimulator, simulatorKit: nil, problem: problem, known: false)
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: developerDir, isDirectory: &isDirectory), isDirectory.boolValue else {
            return unusable("no Xcode: \(developerDir) (from \(source.rawValue)) does not exist")
        }
        if developerDir.hasSuffix("/CommandLineTools") {
            return unusable("no Xcode: \(developerDir) (from \(source.rawValue)) is the Command Line Tools, which have no simulators")
        }
        guard let coreSimulator else {
            return unusable("CoreSimulator is not installed at \(coreSimulatorPath); open Xcode once to install it")
        }
        // Xcode 27 moved SimulatorKit to Contents/SharedFrameworks; Xcode 26 and older keep it in the
        // developer dir (idb v1.7.2 WeakFramework.simulatorKit, and both Xcodes on this Mac).
        let places = [
            ((developerDir as NSString).deletingLastPathComponent as NSString).appendingPathComponent("SharedFrameworks/SimulatorKit.framework"),
            (developerDir as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework"),
        ]
        guard let simulatorKit = places.lazy.compactMap(framework(at:)).first else {
            return unusable("SimulatorKit is not in \(developerDir) (looked in \(places.joined(separator: ", ")))")
        }
        let known = isKnown(FrameworkBuilds(coreSimulator: coreSimulator.build, simulatorKit: simulatorKit.build))
        return Looked(info: info, coreSimulator: coreSimulator, simulatorKit: simulatorKit, problem: nil, known: known)
    }

    private static func reason(chosen: Looked, first: Looked, looked: [Looked]) -> String {
        func origin(_ entry: Looked) -> String {
            switch entry.info.source {
            case .developerDir: "DEVELOPER_DIR names \(entry.name)"
            case .xcodeSelect: "xcode-select points to \(entry.name)"
            case .installed: "\(entry.name) is installed at \(appPath(of: entry.info.developerDir))"
            }
        }
        func row(_ entry: Looked) -> String {
            guard let kit = entry.simulatorKit else { return "which is unusable (\(entry.problem ?? "no SimulatorKit"))" }
            return entry.known ? "whose SimulatorKit \(kit.build) has a version-table row" : "whose SimulatorKit \(kit.build) has no row"
        }
        let passed = looked.prefix { $0.info.developerDir != chosen.info.developerDir }
        if chosen.known {
            let before = passed.map { "\(origin($0)), \(row($0))" }
            return (before + ["\(origin(chosen)), \(row(chosen))"]).joined(separator: "; ")
        }
        return "no Xcode has a version-table row (looked at \(looked.count)); \(origin(first)), \(row(first)), so it stays"
    }

    /// `/Applications/Xcode.app` for `/Applications/Xcode.app/Contents/Developer`.
    static func appPath(of developerDir: String) -> String {
        developerDir.hasSuffix("/Contents/Developer") ? String(developerDir.dropLast("/Contents/Developer".count)) : developerDir
    }

    /// `DEVELOPER_DIR` may name the app (`/Applications/Xcode.app`) as xcrun allows.
    static func normalized(_ path: String) -> String {
        var resolved = (path as NSString).standardizingPath
        let contentsDeveloper = (resolved as NSString).appendingPathComponent("Contents/Developer")
        if resolved.hasSuffix(".app"), FileManager.default.fileExists(atPath: contentsDeveloper) {
            resolved = contentsDeveloper
        }
        return (resolved as NSString).resolvingSymlinksInPath
    }

    static func framework(at path: String) -> FrameworkInfo? {
        guard FileManager.default.fileExists(atPath: path), let info = Bundle(path: path)?.infoDictionary,
              let build = info["CFBundleVersion"] as? String
        else { return nil }
        return FrameworkInfo(path: path, version: info["CFBundleShortVersionString"] as? String ?? build, build: build)
    }

    /// Xcode bundles (`Xcode*.app`, bundle id com.apple.dt.Xcode) in the folders, newest version
    /// first, as developer dirs.
    static func installedXcodes(in folders: [String]) -> [String] {
        var found: [(dir: String, version: [Int])] = []
        for folder in folders {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
            for name in names where name.hasPrefix("Xcode") && name.hasSuffix(".app") {
                let app = (folder as NSString).appendingPathComponent(name)
                guard let info = NSDictionary(contentsOfFile: app + "/Contents/Info.plist"),
                      info["CFBundleIdentifier"] as? String == xcodeBundleID
                else { continue }
                let version = (info["CFBundleShortVersionString"] as? String ?? "0").split(separator: ".").map { Int($0) ?? 0 }
                found.append((app + "/Contents/Developer", version))
            }
        }
        return found.sorted { $1.version.lexicographicallyPrecedes($0.version) }.map(\.dir)
    }

    /// The selection itself: xcode-select prints DEVELOPER_DIR instead when it is set.
    @Sendable static func xcodeSelectPath() -> Result<String, Subprocess.Failure> {
        let environment = ProcessInfo.processInfo.environment.filter { $0.key != "DEVELOPER_DIR" }
        switch Subprocess.run("/usr/bin/xcode-select", ["--print-path"], environment: environment, timeout: 10) {
        case .failure(let problem):
            return .failure(Subprocess.Failure(text: "no Xcode: xcode-select -p \(problem.text)"))
        case .success(let output):
            let path = String(decoding: output.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return path.isEmpty ? .failure(Subprocess.Failure(text: "no Xcode: xcode-select -p printed nothing")) : .success(path)
        }
    }
}
