import Foundation
import Testing
@testable import PodSimKit

@Suite("Helper context")
struct HelperContextTests {
    private func facts(coreSimulator: String, simulatorKit: String) -> EnvironmentFacts {
        EnvironmentFacts(
            xcode: XcodeInfo(developerDir: "/Applications/Xcode-28.0.app/Contents/Developer", source: .xcodeSelect, version: "28.0", build: "28A100"),
            coreSimulator: FrameworkInfo(path: "/nonexistent/CoreSimulator.framework", version: coreSimulator, build: coreSimulator),
            simulatorKit: FrameworkInfo(path: "/nonexistent/SimulatorKit.framework", version: "17.0", build: simulatorKit),
            problem: nil)
    }

    private final class Loads: @unchecked Sendable {
        var count = 0
    }

    @Test("an unknown build, or a known one forced unknown, loads no private framework",
          arguments: [("1200.1", "1050.3", false), ("1171.7", "1005.2", true)])
    func unknownLoadsNothing(_ builds: (String, String, Bool)) {
        let loads = Loads()
        let environment = builds.2 ? [VersionTable.forceUnknownEnvironmentKey: "1"] : [:]
        let context = HelperContext.discover(
            environment: environment, facts: facts(coreSimulator: builds.0, simulatorKit: builds.1),
            loadFrameworks: { _ in loads.count += 1; return .success(()) })
        #expect(loads.count == 0)
        #expect(context.frameworks == nil)
        let report = SelftestRunner.run(SelftestOptions(environment: environment), context: context)
        #expect(report.capabilities.display.status == .unsupported)
        #expect(report.capabilities.screenshot.status == .unsupported)
    }

    @Test("a known build loads the frameworks once (the control for the test above)")
    func knownLoads() {
        let loads = Loads()
        let context = HelperContext.discover(
            environment: [:], facts: facts(coreSimulator: "1171.7", simulatorKit: "1005.2"),
            loadFrameworks: { _ in loads.count += 1; return .failure(HelperError(.failed, "not on this machine")) })
        #expect(loads.count == 1)
        #expect(context.lookup?.entry?.name == "Xcode 27.0 (27A266a)")
    }

    @Test("simctl children get the helper's environment without its token or any POD_SIM_* setting")
    func simctlEnvironment() {
        let environment = SimctlScreenshot.environment("/Applications/Xcode.app/Contents/Developer", base: [
            "PATH": "/usr/bin:/bin", "HOME": "/Users/someone", "POD_SIM_TOKEN": "5f3a9c0e4b7d21865f3a9c0e4b7d2186",
            "POD_SIM_DEVICE_SET": "/private/tmp/set", "POD_SIM_FORCE_UNKNOWN_BUILD": "1",
        ])
        #expect(environment == [
            "PATH": "/usr/bin:/bin", "HOME": "/Users/someone",
            "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer",
        ])
    }
}
