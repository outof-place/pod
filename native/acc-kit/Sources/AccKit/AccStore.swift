import Foundation
import Observation

/// claude-acc's state files, kept current. The scripts write each file atomically (a rename), so
/// a write shows up as a change of its directory: the store watches $STATE and $STATE/sched and
/// also stats the files on an interval, in case an event is missed. Reading never runs a script.
@MainActor
@Observable
public final class AccStore {
    public let paths: AccPaths

    public private(set) var accounts: AccSnapshot?
    public private(set) var devguard: AccGuardState?
    public private(set) var sched: AccSchedState?
    public private(set) var awake: AccAwakeState?
    public private(set) var services: AccPodServices?
    public private(set) var owner: AccOwner?

    @ObservationIgnored private var tracker = AccFileTracker()
    @ObservationIgnored private var watchers: [DispatchSourceFileSystemObject] = []
    @ObservationIgnored private var poll: Task<Void, Never>?

    public init(paths: AccPaths = .account) {
        self.paths = paths
    }

    /// Reads now, then follows the files until `stop()`.
    public func start(interval: Duration = .seconds(10)) {
        stop()
        reload()
        for directory in [paths.state, paths.sched.deletingLastPathComponent()] {
            if let watcher = Self.watch(directory, onChange: { [weak self] in self?.reload() }) {
                watchers.append(watcher)
            }
        }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                self?.reload()
            }
        }
    }

    public func stop() {
        poll?.cancel()
        poll = nil
        watchers.forEach { $0.cancel() }
        watchers = []
    }

    /// Re-reads every file that changed; a file that went away clears its value.
    public func reload() {
        read(paths.accounts) { self.accounts = $0 }
        read(paths.devguard) { self.devguard = $0 }
        read(paths.sched) { self.sched = $0 }
        read(paths.awake) { self.awake = $0 }
        read(paths.podServices) { self.services = $0 }
        read(paths.owner) { self.owner = $0 }
    }

    private func read<T: Decodable>(_ url: URL, assign: (T?) -> Void) {
        guard let data = tracker.changed(url) else { return }
        // an unreadable write keeps the last good value: the next rename brings a whole file
        if data.isEmpty {
            assign(nil)
        } else if let value = AccJSON.decode(T.self, from: data) {
            assign(value)
        }
    }

    private static func watch(
        _ directory: URL, onChange: @escaping @MainActor () -> Void
    ) -> DispatchSourceFileSystemObject? {
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { onChange() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }
}
