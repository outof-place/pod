import Foundation
import Testing

import AccKitTesting

@testable import AccKit

/// A throwaway HOME with claude-acc's state directory; never the account's real one.
private func tempPaths() throws -> AccPaths {
    let home = FileManager.default.temporaryDirectory.appending(path: "acckit-\(UUID().uuidString)")
    let paths = AccPaths(home: home)
    try FileManager.default.createDirectory(
        at: paths.state.appending(path: "sched"), withIntermediateDirectories: true)
    return paths
}

private func write(_ json: String, to url: URL) throws {
    // the scripts write atomically; so do the tests, and the mtime moves with each write
    try Data(json.utf8).write(to: url, options: .atomic)
}

private let accountsJSON = """
    {"generated_at": 1760000000, "active_email": "a@example.com", "foreign_runtime": false,
     "thresholds": {"session_left": 10, "weekly_left": 5}, "host": {"name": "Pod", "bundle_id": "codes.pod.app"},
     "accounts": [
       {"id": "1", "email": "a@example.com", "tier": "max", "active": true, "last_resort": false,
        "status": "ok", "note": "", "usable": true, "session": {"used": 40}, "weekly": {"used": 70}},
       {"id": "2", "email": "b@example.com", "tier": "max", "active": false, "last_resort": false,
        "status": "needs_login", "note": "", "usable": false, "queue": 1}
     ]}
    """

@Suite struct AccKitTests {
    @Test func pathsFollowTheHomeTheyAreGiven() {
        let paths = AccPaths(home: URL(fileURLWithPath: "/Users/someone"))
        #expect(paths.state.path == "/Users/someone/.local/share/claude-acc")
        #expect(paths.sched.path == "/Users/someone/.local/share/claude-acc/sched/state.json")
        #expect(paths.podServices.lastPathComponent == "pod-services.json")
    }

    @Test func accountHomeIgnoresAHomeOverride() {
        // getpwuid, not $HOME: a harness HOME must never stand in for the real install
        let real = AccPaths.accountHome.path
        let saved = ProcessInfo.processInfo.environment["HOME"]
        setenv("HOME", "/private/tmp/acckit-fake-home", 1)
        defer { saved.map { _ = setenv("HOME", $0, 1) } }
        #expect(AccPaths.accountHome.path == real)
        #expect(real != "/private/tmp/acckit-fake-home")
    }

    @Test func decodesTheAccountsSnapshot() throws {
        let snapshot = try #require(AccJSON.decode(AccSnapshot.self, from: Data(accountsJSON.utf8)))
        #expect(snapshot.active?.email == "a@example.com")
        #expect(snapshot.active?.worstUsed == 70)
        #expect(snapshot.next?.email == "b@example.com")
        #expect(snapshot.anyNeedsLogin)
        #expect(snapshot.host?.name == "Pod")
    }

    @Test(arguments: ["status.json", "devguard-state.json", "sched-state.json", "awake-state.json", "pod-services.json", "owner.json"])
    func everyFixtureDecodes(fixture: String) {
        let data = AccFixtures.data(fixture)
        let decoded: Bool = switch fixture {
        case "status.json": AccJSON.decode(AccSnapshot.self, from: data) != nil
        case "devguard-state.json": AccJSON.decode(AccGuardState.self, from: data)?.snapshot?.units.first?.place == "site-spacing"
        case "sched-state.json": AccJSON.decode(AccSchedState.self, from: data)?.busy == true
        case "awake-state.json": AccJSON.decode(AccAwakeState.self, from: data)?.until != nil
        case "pod-services.json": AccJSON.decode(AccPodServices.self, from: data)?.needsApproval.count == 1
        default: AccJSON.decode(AccOwner.self, from: data)?.isPod == true
        }
        #expect(decoded, "\(fixture)")
    }

    @MainActor
    @Test func storeReadsAWholeFixtureState() async throws {
        let store = AccStore(paths: try AccFixtures.makeState())
        await store.reload()
        #expect(store.accounts?.accounts.count == 3)
        #expect(store.devguard?.snapshot?.units.first?.target == ":3000")
        #expect(store.sched?.queue.first?.reason?.needGb == 23.4)
        #expect(store.awake?.on == true)
        #expect(store.services?.services.count == 3)
        #expect(store.owner?.isPod == true)
    }

    @Test func performThrowsTheScriptsStatusAndStderr() async throws {
        let paths = try tempPaths()
        try write("#!/bin/sh\necho 'nie ma takiego konta' >&2\nexit 3\n", to: paths.python)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: paths.python.path)
        await #expect(throws: AccActionError(
            action: .switchAccount(email: "x@example.com"), status: 3,
            stderr: "nie ma takiego konta\n", message: "nie ma takiego konta")
        ) {
            try await AccActions(paths: paths).perform(.switchAccount(email: "x@example.com"))
        }
    }

    @Test func decodesASchedStateWithoutItsLists() throws {
        let sched = try #require(AccJSON.decode(AccSchedState.self, from: Data(#"{"updated_at": 1}"#.utf8)))
        #expect(sched.running.isEmpty && sched.queue.isEmpty && sched.recent.isEmpty)
        #expect(!sched.busy)
    }

    @Test func decodesPodServicesAndFlagsTheOnesAwaitingApproval() throws {
        let json = """
            {"version": 1, "at": "2026-10-10T05:10:00.000Z", "app": "/Applications/Pod.app", "payload": "1.31.0",
             "services": [{"kind": "agent", "name": "codes.pod.app.acc.tick.plist", "status": "enabled"},
                          {"kind": "login-item", "name": "com.filip.claude-acc.menubar", "status": "requires-approval"}]}
            """
        let services = try #require(AccJSON.decode(AccPodServices.self, from: Data(json.utf8)))
        #expect(services.needsApproval.map(\.name) == ["com.filip.claude-acc.menubar"])
        #expect(services.services.first?.kind == .agent)
    }

    @MainActor
    @Test func storeFollowsWritesRemovalsAndKeepsTheLastGoodValue() async throws {
        let paths = try tempPaths()
        let store = AccStore(paths: paths)
        await store.reload()
        #expect(store.accounts == nil)

        try write(accountsJSON, to: paths.accounts)
        try write(#"{"owner": "pod", "version": "1.31.0", "app": "/Applications/Pod.app", "at": 1760000000}"#, to: paths.owner)
        await store.reload()
        #expect(store.accounts?.accounts.count == 2)
        #expect(store.owner?.isPod == true)

        try write("{not json", to: paths.accounts)
        await store.reload()
        #expect(store.accounts?.accounts.count == 2)

        try FileManager.default.removeItem(at: paths.owner)
        await store.reload()
        #expect(store.owner == nil)
    }

    @MainActor
    @Test func startedStoreSeesAnAtomicWriteWithoutPolling() async throws {
        let paths = try tempPaths()
        let store = AccStore(paths: paths)
        store.start(interval: .seconds(3600))
        defer { store.stop() }
        try write(accountsJSON, to: paths.accounts)
        for _ in 0..<100 where store.accounts == nil {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(store.accounts?.activeEmail == "a@example.com")
    }

    @Test func actionsSendTheScriptsTheirOwnArguments() {
        #expect(AccAction.switchAccount(email: "b@example.com").arguments == ["accswitch", "switch", "b@example.com"])
        #expect(AccAction.schedCancel(job: "j-1-abcd").arguments == ["sched", "cancel", "j-1-abcd", "--json"])
        #expect(AccAction.schedCancel(job: "pane-3", kill: true).arguments.last == "--kill")
        #expect(AccAction.awake(on: true, forSeconds: 5400).arguments == ["awake", "on", "--for", "5400"])
        #expect(AccAction.awake(on: false, forSeconds: 5400).arguments == ["awake", "off"])
        #expect(AccAction.guardRestart(target: ":3000").arguments == ["devguard", "recycle", ":3000"])
    }

    @Test func runsThroughStatesInterpreterWithItsHome() async throws {
        let paths = try tempPaths()
        // a stand-in interpreter: prints HOME and what acc.py would get
        try write("#!/bin/sh\necho \"$HOME|$*\"\n", to: paths.python)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: paths.python.path)
        let result = await AccActions(paths: paths).run(.guardStop(target: ":3000"))
        #expect(result.status == 0)
        #expect(result.message == "\(paths.home.path)|\(paths.launcher.path) devguard stop :3000")
    }
}
