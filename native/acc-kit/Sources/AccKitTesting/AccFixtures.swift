import AccKit
import Foundation

/// claude-acc state files with made-up accounts (example.com), for tests and SwiftUI previews of
/// anything built on AccKit. Shapes follow what the scripts write today.
public enum AccFixtures {
    /// File name in Fixtures/ and where the scripts put it under $STATE.
    private static var files: [(fixture: String, path: KeyPath<AccPaths, URL>)] {
        [
            ("status.json", \.accounts),
            ("devguard-state.json", \.devguard),
            ("sched-state.json", \.sched),
            ("awake-state.json", \.awake),
            ("pod-services.json", \.podServices),
            ("owner.json", \.owner),
        ]
    }

    public static func data(_ fixture: String) -> Data {
        guard let url = Bundle.module.url(forResource: fixture, withExtension: nil, subdirectory: "Fixtures"),
              let data = try? Data(contentsOf: url)
        else { preconditionFailure("AccKitTesting has no fixture \(fixture)") }
        return data
    }

    /// A throwaway HOME whose $STATE holds every fixture: point an `AccStore` at it.
    public static func makeState() throws -> AccPaths {
        let home = FileManager.default.temporaryDirectory.appending(path: "acckit-\(UUID().uuidString)")
        let paths = AccPaths(home: home)
        for (fixture, path) in files {
            let url = paths[keyPath: path]
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data(fixture).write(to: url, options: .atomic)
        }
        return paths
    }
}
