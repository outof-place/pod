import Foundation
import Testing
@testable import PodSimKit

@Suite("Version table")
struct VersionTableTests {
    /// Xcode 27.0 (27A266a) on this Mac, as stage 0 measured it.
    let xcode27 = FrameworkBuilds(coreSimulator: "1171.7", simulatorKit: "1005.2")
    /// AccessibilityPlatformTranslation on macOS 27.0.1 (26A434).
    let translator587 = "587"
    /// What this binary implements, stage 3 included.
    let implemented = SelftestRunner.implemented

    @Test("the bundled table knows Xcode 27.0 with translator 587 and picks the stage 0 paths, hid and ax included")
    func bundledKnowsXcode27() throws {
        let lookup = try VersionTable.bundled().lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: translator587)
        #expect(lookup.entry?.name == "Xcode 27.0 (27A266a)")
        #expect(lookup.verdicts[.display] == .implementation("screenCallbacks"))
        #expect(lookup.verdicts[.screenshot] == .implementation("surface"))
        #expect(lookup.verdicts[.hid] == .implementation("dtuhid"))
        #expect(lookup.verdicts[.ax] == .implementation("translatorWalk"))
    }

    @Test("a capability this binary does not implement yet is unsupported whatever the row says")
    func notImplementedYet() throws {
        let stage2a: [Capability: Set<String>] = [.display: ["screenCallbacks"], .screenshot: ["surface"]]
        let lookup = try VersionTable.bundled().lookup(xcode27, forcedUnknown: false, implemented: stage2a, translatorBuild: translator587)
        #expect(lookup.verdicts[.hid] == .unsupported("not in this helper yet"))
        #expect(lookup.verdicts[.ax] == .unsupported("not in this helper yet"))
    }

    @Test("a translator build the table does not list turns ax alone unsupported, with its build; hid stands")
    func unlistedTranslator() throws {
        let table = try VersionTable.bundled()
        let newer = table.lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: "601")
        #expect(newer.verdicts[.ax] == .unsupported("AccessibilityPlatformTranslation 601 is not in the version table for ax"))
        #expect(newer.verdicts[.hid] == .implementation("dtuhid"))
        #expect(newer.verdicts[.display] == .implementation("screenCallbacks"))
        let unread = table.lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: nil)
        #expect(unread.verdicts[.ax] == .unsupported("AccessibilityPlatformTranslation (build unknown) is not in the version table for ax"))
    }

    @Test("an override row turns ax on for a new translator, and a row naming another implementation blocks it")
    func overrideAccessibility() throws {
        let override = try VersionTable.decode(Data("""
        {"schema": 1, "builds": [], "accessibility": [
          {"name": "AccessibilityPlatformTranslation 1.0 (601)", "translator": "601", "ax": "translatorWalk", "macOS": "27.1 (26B5040e)"},
          {"name": "587 moved to another walk", "translator": "587", "ax": "batchedWalk"}
        ]}
        """.utf8))
        let table = try VersionTable.bundled().overlaid(by: override)
        let on = table.lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: "601")
        #expect(on.verdicts[.ax] == .implementation("translatorWalk"))
        let blocked = table.lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: translator587)
        #expect(blocked.verdicts[.ax] == .unsupported("AccessibilityPlatformTranslation 587 is listed for ax batchedWalk, not translatorWalk"))
        #expect(blocked.verdicts[.hid] == .implementation("dtuhid"))
    }

    @Test("an override written before ax (builds only) leaves the bundled translator rows in charge")
    func overrideWithoutAccessibility() throws {
        let override = try VersionTable.decode(Data("""
        {"schema": 1, "builds": [{"name": "Xcode 27.0, re-verified", "coreSimulator": "1171.7", "simulatorKit": "1005.2",
          "capabilities": {"display": "screenCallbacks", "screenshot": "surface", "hid": "dtuhid", "ax": "translatorWalk"}}]}
        """.utf8))
        let lookup = try VersionTable.bundled().overlaid(by: override)
            .lookup(xcode27, forcedUnknown: false, implemented: implemented, translatorBuild: translator587)
        #expect(lookup.entry?.name == "Xcode 27.0, re-verified")
        #expect(lookup.verdicts[.ax] == .implementation("translatorWalk"))
    }

    @Test("an unknown build is unsupported for every capability and names the builds it saw")
    func unknownBuild() throws {
        let builds = FrameworkBuilds(coreSimulator: "1200.1", simulatorKit: "1050.3")
        let lookup = try VersionTable.bundled().lookup(builds, forcedUnknown: false, implemented: implemented, translatorBuild: translator587)
        #expect(lookup.entry == nil)
        let reason = "CoreSimulator 1200.1 with SimulatorKit 1050.3 is not in the version table"
        #expect(lookup.verdicts[.display] == .unsupported(reason))
        #expect(lookup.verdicts[.screenshot] == .unsupported(reason))
        #expect(lookup.verdicts[.hid] == .unsupported(reason))
        #expect(lookup.verdicts[.ax] == .unsupported(reason))
    }

    @Test("the same SimulatorKit version string with another build is still unknown (Xcode 26.6 ships 16.0 as 955.7)")
    func keyedByBuildNotVersion() throws {
        let xcode266 = FrameworkBuilds(coreSimulator: "1171.7", simulatorKit: "955.7")
        let lookup = try VersionTable.bundled().lookup(xcode266, forcedUnknown: false, implemented: implemented)
        #expect(lookup.verdicts[.display] == .unsupported("CoreSimulator 1171.7 with SimulatorKit 955.7 is not in the version table"))
    }

    @Test("forcing an unknown build turns a known one unsupported and says it was forced")
    func forcedUnknown() throws {
        let lookup = try VersionTable.bundled().lookup(xcode27, forcedUnknown: true, implemented: implemented)
        #expect(lookup.entry == nil)
        #expect(lookup.verdicts[.display] == .unsupported("treated as unknown (POD_SIM_FORCE_UNKNOWN_BUILD=1)"))
        #expect(lookup.verdicts[.screenshot] == .unsupported("treated as unknown (POD_SIM_FORCE_UNKNOWN_BUILD=1)"))
    }

    @Test("an override entry replaces the bundled entry for its builds and adds new builds")
    func overrideReplacesAndAdds() throws {
        let override = try VersionTable.decode(Data("""
        {"schema": 1, "builds": [
          {"name": "Xcode 27.0, display blocked", "coreSimulator": "1171.7", "simulatorKit": "1005.2",
           "capabilities": {"screenshot": "surface"}},
          {"name": "Xcode 27.1", "coreSimulator": "1172.1", "simulatorKit": "1006.0",
           "capabilities": {"display": "screenCallbacks", "screenshot": "surface"}}
        ]}
        """.utf8))
        let table = try VersionTable.bundled().overlaid(by: override)

        let blocked = table.lookup(xcode27, forcedUnknown: false, implemented: implemented)
        #expect(blocked.entry?.name == "Xcode 27.0, display blocked")
        #expect(blocked.verdicts[.display] == .unsupported("not supported with CoreSimulator 1171.7 and SimulatorKit 1005.2"))
        #expect(blocked.verdicts[.screenshot] == .implementation("surface"))

        let added = table.lookup(FrameworkBuilds(coreSimulator: "1172.1", simulatorKit: "1006.0"), forcedUnknown: false, implemented: implemented)
        #expect(added.verdicts[.display] == .implementation("screenCallbacks"))
    }

    @Test("an implementation this binary does not have is unsupported, not attempted")
    func unknownImplementation() throws {
        let override = try VersionTable.decode(Data("""
        {"schema": 1, "builds": [{"name": "future", "coreSimulator": "1171.7", "simulatorKit": "1005.2",
          "capabilities": {"display": "metalTaps", "screenshot": "surface", "hid": "dtuhid"}}]}
        """.utf8))
        let lookup = override.lookup(xcode27, forcedUnknown: false, implemented: implemented)
        #expect(lookup.verdicts[.display] == .unsupported("this helper has no display implementation named metalTaps"))
        #expect(lookup.verdicts[.hid] == .implementation("dtuhid"))
        #expect(lookup.verdicts[.ax] == .unsupported("not supported with CoreSimulator 1171.7 and SimulatorKit 1005.2"))
    }

    @Test("a table with another schema or no builds list is refused")
    func badTables() {
        #expect(throws: VersionTableError.self) { try VersionTable.decode(Data(#"{"schema": 2, "builds": []}"#.utf8)) }
        #expect(throws: VersionTableError.self) { try VersionTable.decode(Data(#"{"schema": 1}"#.utf8)) }
        #expect(throws: VersionTableError.self) { try VersionTable.decode(Data("not json".utf8)) }
    }

    @Test("loading: an unreadable override leaves the bundled table in charge and says why")
    func loadOverride() throws {
        let missing = VersionTableSource.load(overridePath: "/nonexistent/pod-sim-table.json")
        #expect(missing.source == .bundled)
        #expect(missing.overrideError?.contains("/nonexistent/pod-sim-table.json") == true)
        #expect(missing.table.lookup(xcode27, forcedUnknown: false, implemented: implemented).entry != nil)

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-table-\(UUID().uuidString).json")
        try Data(#"{"schema": 1, "builds": [{"name": "only override", "coreSimulator": "1", "simulatorKit": "2", "capabilities": {}}]}"#.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let loaded = VersionTableSource.load(overridePath: url.path)
        #expect(loaded.source == .override)
        #expect(loaded.overrideError == nil)
        #expect(loaded.table.lookup(FrameworkBuilds(coreSimulator: "1", simulatorKit: "2"), forcedUnknown: false, implemented: implemented).entry?.name == "only override")
        #expect(loaded.table.lookup(xcode27, forcedUnknown: false, implemented: implemented).entry?.name == "Xcode 27.0 (27A266a)")
    }
}
