import Foundation

/// The claude-acc commands a surface may run. Each maps to `acc.py <script> <args>`, the same
/// argument vectors ClaudeAcc's menu sends; a script's own checks still decide.
public enum AccAction: Equatable, Sendable {
    case switchAccount(email: String)
    case resume
    /// A queued or running scheduler job, by id (`j-…`) or by the host's pane key.
    case schedCancel(job: String, kill: Bool = false)
    case awake(on: Bool, forSeconds: Int? = nil)
    case guardStop(target: String)
    case guardRestart(target: String)

    public var arguments: [String] {
        switch self {
        case .switchAccount(let email): ["accswitch", "switch", email]
        case .resume: ["accswitch", "resume"]
        case .schedCancel(let job, let kill): ["sched", "cancel", job, "--json"] + (kill ? ["--kill"] : [])
        case .awake(let on, let seconds):
            ["awake", on ? "on" : "off"] + (on ? seconds.map { ["--for", String($0)] } ?? [] : [])
        case .guardStop(let target): ["devguard", "stop", target]
        case .guardRestart(let target): ["devguard", "recycle", target]
        }
    }
}

public struct AccCommandResult: Equatable, Sendable {
    public let status: Int32
    public let stdout: String
    public let stderr: String

    /// The script's last line: its own sentence for success or for the refusal.
    public var message: String {
        "\(stdout)\n\(stderr)".split(separator: "\n").last.map(String.init) ?? ""
    }
}

/// A command that ran and exited non-zero (or never started: status -1).
public struct AccActionError: Error, Equatable, Sendable {
    public let action: AccAction
    public let status: Int32
    public let stderr: String
    /// The script's last line, usually its own explanation.
    public let message: String
}

public struct AccActions: Sendable {
    public let paths: AccPaths

    public init(paths: AccPaths = .account) {
        self.paths = paths
    }

    /// The process for an action: $STATE's interpreter running acc.py, never a shell.
    public func command(_ action: AccAction) -> (executable: URL, arguments: [String], environment: [String: String]) {
        let python = FileManager.default.isExecutableFile(atPath: paths.python.path)
            ? paths.python : URL(fileURLWithPath: "/usr/bin/python3")
        let home = paths.home
        // an app started by launchd gets a thin environment: the scripts need USER (the Keychain
        // account) and a PATH that finds `claude` and the host's CLI
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = home.path
        environment["USER"] = NSUserName()
        environment["PATH"] = "\(home.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return (python, [paths.launcher.path] + action.arguments, environment)
    }

    /// Runs it and throws its exit status and stderr when it fails; the output on success.
    @concurrent
    public func perform(_ action: AccAction) async throws(AccActionError) -> AccCommandResult {
        let result = await run(action)
        guard result.status == 0 else {
            throw AccActionError(
                action: action, status: result.status, stderr: result.stderr, message: result.message)
        }
        return result
    }

    /// Runs off the caller's actor; never throws, the result carries the exit status.
    @concurrent
    public func run(_ action: AccAction) async -> AccCommandResult {
        let (executable, arguments, environment) = command(action)
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        return Self.runBlocking(process)
    }

    nonisolated static func runBlocking(_ process: Process) -> AccCommandResult {
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do {
            try process.run()
        } catch {
            return AccCommandResult(status: -1, stdout: "", stderr: error.localizedDescription)
        }
        // read both pipes to the end at the same time, or a full pipe stalls the script
        let errData = DataBox()
        let errHandle = err.fileHandleForReading
        let group = DispatchGroup()
        DispatchQueue.global().async(group: group) { errData.value = errHandle.readDataToEndOfFile() }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        process.waitUntilExit()
        return AccCommandResult(
            status: process.terminationStatus,
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData.value, as: UTF8.self))
    }
}

/// Written by one reader thread, read after `group.wait()`: the group orders the two.
private final class DataBox: @unchecked Sendable {
    var value = Data()
}
