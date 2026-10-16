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
    }

    public let developerDir: String
    public let source: Source
    public let version: String?
    public let build: String?
}

/// What the helper found before loading anything private: versions come from Info.plists, so an
/// unknown build is reported without ever running its code.
public struct EnvironmentFacts: Sendable {
    public var xcode: XcodeInfo?
    public var coreSimulator: FrameworkInfo?
    public var simulatorKit: FrameworkInfo?
    public var problem: String?

    public var builds: FrameworkBuilds? {
        guard problem == nil, let coreSimulator, let simulatorKit else { return nil }
        return FrameworkBuilds(coreSimulator: coreSimulator.build, simulatorKit: simulatorKit.build)
    }
}

public enum XcodeEnvironmentResolver {
    /// System-wide, installed by Xcode's first launch; Xcode 27's own `simctl` wrapper reads this path.
    static let coreSimulatorPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework"

    public static func resolve(environment: [String: String]) -> EnvironmentFacts {
        var facts = EnvironmentFacts()
        let developerDir: String
        let source: XcodeInfo.Source
        if let fromEnv = environment["DEVELOPER_DIR"], !fromEnv.isEmpty {
            developerDir = normalized(fromEnv)
            source = .developerDir
        } else {
            switch xcodeSelectPath() {
            case .failure(let problem):
                facts.problem = problem.text
                return facts
            case .success(let path):
                developerDir = normalized(path)
                source = .xcodeSelect
            }
        }
        let version = NSDictionary(contentsOfFile: (developerDir as NSString).deletingLastPathComponent + "/version.plist")
        facts.xcode = XcodeInfo(
            developerDir: developerDir, source: source,
            version: version?["CFBundleShortVersionString"] as? String, build: version?["ProductBuildVersion"] as? String)

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: developerDir, isDirectory: &isDirectory), isDirectory.boolValue else {
            facts.problem = "no Xcode: \(developerDir) (from \(source.rawValue)) does not exist"
            return facts
        }
        if developerDir.hasSuffix("/CommandLineTools") {
            facts.problem = "no Xcode: \(developerDir) (from \(source.rawValue)) is the Command Line Tools, which have no simulators"
            return facts
        }
        facts.coreSimulator = framework(at: coreSimulatorPath)
        guard facts.coreSimulator != nil else {
            facts.problem = "CoreSimulator is not installed at \(coreSimulatorPath); open Xcode once to install it"
            return facts
        }
        // Xcode 27 moved SimulatorKit to Contents/SharedFrameworks; Xcode 26 and older keep it in the
        // developer dir (idb v1.7.2 WeakFramework.simulatorKit, and both Xcodes on this Mac).
        let candidates = [
            ((developerDir as NSString).deletingLastPathComponent as NSString).appendingPathComponent("SharedFrameworks/SimulatorKit.framework"),
            (developerDir as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework"),
        ]
        facts.simulatorKit = candidates.lazy.compactMap(framework(at:)).first
        if facts.simulatorKit == nil {
            facts.problem = "SimulatorKit is not in \(developerDir) (looked in \(candidates.joined(separator: ", ")))"
        }
        return facts
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

    private static func xcodeSelectPath() -> Result<String, Subprocess.Failure> {
        switch Subprocess.run("/usr/bin/xcode-select", ["--print-path"], environment: nil, timeout: 10) {
        case .failure(let problem):
            return .failure(Subprocess.Failure(text: "no Xcode: xcode-select -p \(problem.text)"))
        case .success(let output):
            let path = String(decoding: output.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return path.isEmpty ? .failure(Subprocess.Failure(text: "no Xcode: xcode-select -p printed nothing")) : .success(path)
        }
    }
}
