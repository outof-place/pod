import Darwin
import Foundation

/// Where claude-acc keeps its state: `~/.local/share/claude-acc` ($STATE) in the account's home.
public struct AccPaths: Sendable, Equatable {
    /// The home the scripts run with (HOME): claude-acc keys its Keychain reads and paths off it.
    public let home: URL
    public let state: URL

    public init(home: URL) {
        self.home = home
        state = home.appending(path: ".local/share/claude-acc", directoryHint: .isDirectory)
    }

    /// The account's home from the user database (getpwuid). A HOME override (tests, harness
    /// launches) cannot move it, so a throwaway HOME never shows or drives the real install.
    public static var accountHome: URL {
        if let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    }

    public static var account: AccPaths { AccPaths(home: accountHome) }

    func file(_ name: String) -> URL { state.appending(path: name, directoryHint: .notDirectory) }

    /// `status --json` as every account tick writes it (launchd runs one every 2 minutes).
    public var accounts: URL { file("status.json") }
    public var devguard: URL { file("devguard-state.json") }
    public var sched: URL { file("sched/state.json") }
    public var awake: URL { file("awake-state.json") }
    /// What Pod registered with launchd (src/main/pod/acc/acc-services.ts).
    public var podServices: URL { file("pod-services.json") }
    public var owner: URL { file("owner.json") }

    /// The interpreter setup.sh links (Pod's embedded one, uv's, or the system's).
    public var python: URL { file("python") }
    /// Runs a claude-acc script from cached bytecode: `acc.py <script> <args>`.
    public var launcher: URL { file("acc.py") }
}
