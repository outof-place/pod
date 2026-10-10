import Foundation
import Observation

/// One file's news since the last read.
enum AccChange<Value: Sendable>: Sendable {
    case unchanged
    case removed
    case value(Value)
}

/// Everything a reload found, decoded off the main actor.
struct AccReading: Sendable {
    var accounts: AccChange<AccSnapshot> = .unchanged
    var devguard: AccChange<AccGuardState> = .unchanged
    var sched: AccChange<AccSchedState> = .unchanged
    var awake: AccChange<AccAwakeState> = .unchanged
    var services: AccChange<AccPodServices> = .unchanged
    var owner: AccChange<AccOwner> = .unchanged
}

/// Stats, reads and decodes on its own executor, so the main actor only assigns.
actor AccReader {
    private let paths: AccPaths
    private var tracker = AccFileTracker()

    init(paths: AccPaths) {
        self.paths = paths
    }

    func read() -> AccReading {
        AccReading(
            accounts: change(paths.accounts),
            devguard: change(paths.devguard),
            sched: change(paths.sched),
            awake: change(paths.awake),
            services: change(paths.podServices),
            owner: change(paths.owner))
    }

    private func change<T: Decodable & Sendable>(_ url: URL) -> AccChange<T> {
        guard let data = tracker.changed(url) else { return .unchanged }
        if data.isEmpty { return .removed }
        // an unreadable write keeps the last good value: the next rename brings a whole file
        return AccJSON.decode(T.self, from: data).map(AccChange.value) ?? .unchanged
    }
}

/// claude-acc's state files, kept current. The scripts write each file atomically (a rename), so
/// a write shows up as a change of its directory: the store watches $STATE and $STATE/sched on a
/// utility queue and also stats the files on an interval, in case an event is missed. Reading
/// never runs a script. Make one per app and share it (SwiftUI `.environment`).
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

    @ObservationIgnored private let reader: AccReader
    @ObservationIgnored private var watchers: [DispatchSourceFileSystemObject] = []
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var reloading = false
    @ObservationIgnored private var reloadAgain = false

    private nonisolated static let events = DispatchQueue(label: "AccKit.events", qos: .utility)

    public init(paths: AccPaths = .account) {
        self.paths = paths
        reader = AccReader(paths: paths)
    }

    /// Reads now, then follows the files until `stop()`.
    public func start(interval: Duration = .seconds(10)) {
        stop()
        for directory in [paths.state, paths.sched.deletingLastPathComponent()] {
            if let watcher = Self.watch(directory, onChange: { [weak self] in
                Task { await self?.reload() }
            }) {
                watchers.append(watcher)
            }
        }
        poll = Task { [weak self] in
            await self?.reload()
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                await self?.reload()
            }
        }
    }

    public func stop() {
        poll?.cancel()
        poll = nil
        watchers.forEach { $0.cancel() }
        watchers = []
    }

    /// Re-reads every file that changed; a file that went away clears its value. Calls that
    /// arrive while one runs fold into a single follow-up read.
    public func reload() async {
        if reloading {
            reloadAgain = true
            return
        }
        reloading = true
        defer { reloading = false }
        repeat {
            reloadAgain = false
            apply(await reader.read())
        } while reloadAgain
    }

    private func apply(_ reading: AccReading) {
        Self.assign(reading.accounts) { accounts = $0 }
        Self.assign(reading.devguard) { devguard = $0 }
        Self.assign(reading.sched) { sched = $0 }
        Self.assign(reading.awake) { awake = $0 }
        Self.assign(reading.services) { services = $0 }
        Self.assign(reading.owner) { owner = $0 }
    }

    /// Observation notifies on every assignment, equal or not: unchanged files assign nothing.
    private static func assign<T>(_ change: AccChange<T>, _ set: (T?) -> Void) {
        switch change {
        case .unchanged: break
        case .removed: set(nil)
        case .value(let value): set(value)
        }
    }

    private nonisolated static func watch(
        _ directory: URL, onChange: @escaping @Sendable () -> Void
    ) -> DispatchSourceFileSystemObject? {
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: events)
        source.setEventHandler(handler: onChange)
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }
}
