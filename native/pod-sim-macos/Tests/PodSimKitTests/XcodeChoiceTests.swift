import Foundation
import Testing
@testable import PodSimKit

/// Fake Xcodes on disk: an app with version.plist and a SimulatorKit whose build decides the table row.
private final class FakeXcodes {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-xcodes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try plist(["CFBundleVersion": "1171.7", "CFBundleShortVersionString": "1171.7"],
                  at: root.appendingPathComponent("CoreSimulator.framework/Resources/Info.plist"))
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    var coreSimulator: String { root.appendingPathComponent("CoreSimulator.framework").path }

    /// Returns the developer dir. `kit` nil leaves SimulatorKit out.
    @discardableResult
    func xcode(_ name: String, version: String, build: String, kit: String?, folder: String = "Applications", bundleID: String = "com.apple.dt.Xcode") throws -> String {
        let app = root.appendingPathComponent("\(folder)/\(name).app")
        try plist(["CFBundleShortVersionString": version, "ProductBuildVersion": build], at: app.appendingPathComponent("Contents/version.plist"))
        try plist(["CFBundleIdentifier": bundleID, "CFBundleShortVersionString": version], at: app.appendingPathComponent("Contents/Info.plist"))
        let developer = app.appendingPathComponent("Contents/Developer")
        try FileManager.default.createDirectory(at: developer, withIntermediateDirectories: true)
        if let kit {
            try plist(["CFBundleVersion": kit, "CFBundleShortVersionString": "16.0"],
                      at: app.appendingPathComponent("Contents/SharedFrameworks/SimulatorKit.framework/Resources/Info.plist"))
        }
        return (developer.path as NSString).resolvingSymlinksInPath
    }

    func folder(_ name: String = "Applications") -> String { root.appendingPathComponent(name).path }

    private func plist(_ values: [String: String], at url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0).write(to: url)
    }

    func resolve(developerDir: String?, select: Result<String, Subprocess.Failure>, installed: [String] = []) -> EnvironmentFacts {
        let discovery = XcodeEnvironmentResolver.Discovery(
            xcodeSelect: { select }, installed: { _ in installed }, coreSimulatorPath: coreSimulator)
        return XcodeEnvironmentResolver.resolve(
            environment: developerDir.map { ["DEVELOPER_DIR": $0] } ?? [:],
            isKnown: { $0.simulatorKit == "1005.2" }, discovery: discovery)
    }
}

@Suite("Xcode choice")
struct XcodeChoiceTests {
    @Test("DEVELOPER_DIR with a table row wins and xcode-select is never asked")
    func developerDirKnown() throws {
        let xcodes = try FakeXcodes()
        let known = try xcodes.xcode("Xcode", version: "27.0", build: "27A266a", kit: "1005.2")
        let facts = xcodes.resolve(developerDir: known, select: .failure(Subprocess.Failure(text: "must not be asked")))
        #expect(facts.xcode?.developerDir == known)
        #expect(facts.xcode?.source == .developerDir)
        #expect(facts.xcode?.candidates == nil)
        #expect(facts.problem == nil)
        #expect(facts.simulatorKit?.build == "1005.2")
    }

    @Test("DEVELOPER_DIR without a row gives way to xcode-select's known Xcode, and both are listed with the reason")
    func developerDirUnknown() throws {
        let xcodes = try FakeXcodes()
        let old = try xcodes.xcode("Xcode-26.6", version: "26.6", build: "17F113", kit: "955.7")
        let known = try xcodes.xcode("Xcode", version: "27.0", build: "27A266a", kit: "1005.2")
        let facts = xcodes.resolve(developerDir: old, select: .success(known))
        let xcode = try #require(facts.xcode)
        #expect(xcode.developerDir == known && xcode.source == .xcodeSelect)
        #expect(xcode.candidates?.map(\.developerDir) == [old, known])
        #expect(xcode.candidates?.map(\.known) == [false, true])
        #expect(xcode.chosenBecause == "DEVELOPER_DIR names Xcode 26.6 (17F113), whose SimulatorKit 955.7 has no row; "
            + "xcode-select points to Xcode 27.0 (27A266a), whose SimulatorKit 1005.2 has a version-table row")
    }

    @Test("a Dock-launched Pod (no DEVELOPER_DIR) whose xcode-select names an Xcode with no row finds a known one installed")
    func installedFallback() throws {
        let xcodes = try FakeXcodes()
        let selected = try xcodes.xcode("Xcode-beta", version: "28.0", build: "28A5", kit: "1100.1")
        let known = try xcodes.xcode("Xcode", version: "27.0", build: "27A266a", kit: "1005.2")
        let facts = xcodes.resolve(developerDir: nil, select: .success(selected), installed: [selected, known])
        let xcode = try #require(facts.xcode)
        #expect(xcode.developerDir == known && xcode.source == .installed)
        #expect(xcode.candidates?.map(\.source) == [.xcodeSelect, .installed], "xcode-select's Xcode is not looked at twice")
        let reason = try #require(xcode.chosenBecause)
        #expect(reason.hasPrefix("xcode-select points to Xcode 28.0 (28A5), whose SimulatorKit 1100.1 has no row; Xcode 27.0 (27A266a) is installed at "))
        #expect(reason.hasSuffix("/Applications/Xcode.app, whose SimulatorKit 1005.2 has a version-table row"))
    }

    @Test("xcode-select naming the Command Line Tools is passed over for an installed Xcode")
    func commandLineTools() throws {
        let xcodes = try FakeXcodes()
        let tools = xcodes.folder("Library/Developer/CommandLineTools")
        try FileManager.default.createDirectory(atPath: tools, withIntermediateDirectories: true)
        let known = try xcodes.xcode("Xcode", version: "27.0", build: "27A266a", kit: "1005.2")
        let facts = xcodes.resolve(developerDir: nil, select: .success(tools), installed: [known])
        #expect(facts.xcode?.developerDir == known)
        #expect(facts.problem == nil)
        #expect(facts.xcode?.candidates?.first?.problem?.contains("Command Line Tools") == true)
    }

    @Test("with no known Xcode the first one stays, unknown, so nothing private loads")
    func noneKnown() throws {
        let xcodes = try FakeXcodes()
        let first = try xcodes.xcode("Xcode-26.6", version: "26.6", build: "17F113", kit: "955.7")
        let second = try xcodes.xcode("Xcode-beta", version: "28.0", build: "28A5", kit: "1100.1")
        let facts = xcodes.resolve(developerDir: first, select: .success(second))
        #expect(facts.xcode?.developerDir == first && facts.xcode?.source == .developerDir)
        #expect(facts.simulatorKit?.build == "955.7")
        #expect(facts.xcode?.chosenBecause?.hasPrefix("no Xcode has a version-table row (looked at 2)") == true)
    }

    @Test("no Xcode anywhere reports xcode-select's problem")
    func nothing() throws {
        let xcodes = try FakeXcodes()
        let facts = xcodes.resolve(developerDir: nil, select: .failure(Subprocess.Failure(text: "no Xcode: xcode-select -p exited 2")))
        #expect(facts.xcode == nil)
        #expect(facts.problem == "no Xcode: xcode-select -p exited 2")
    }

    @Test("installed Xcodes are Xcode bundles only, newest version first")
    func installedOrder() throws {
        let xcodes = try FakeXcodes()
        let older = try xcodes.xcode("Xcode-26.6", version: "26.6", build: "17F113", kit: "955.7")
        let newer = try xcodes.xcode("Xcode", version: "27.0", build: "27A266a", kit: "1005.2")
        let mine = try xcodes.xcode("Xcode-27.1", version: "27.1", build: "27B10", kit: "1006.1", folder: "home/Applications")
        try xcodes.xcode("Xcodes", version: "2.0", build: "1", kit: nil, bundleID: "com.robotsandpencils.XcodesApp")
        let found = XcodeEnvironmentResolver.installedXcodes(in: [xcodes.folder(), xcodes.folder("home/Applications")])
            .map { ($0 as NSString).resolvingSymlinksInPath }
        #expect(found == [mine, newer, older])
    }
}
