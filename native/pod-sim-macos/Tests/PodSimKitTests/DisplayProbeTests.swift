import Foundation
import Testing
@testable import PodSimKit

@Suite("Display self-test")
struct DisplayProbeTests {
    private func stats(frames: Int, surfaces: Int) -> DisplayStats {
        DisplayStats(udid: "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", seconds: 1.5, frameCallbacks: frames, surfaceCallbacks: surfaces, seedChanges: frames)
    }

    @Test("frames that arrived pass at device level and are counted")
    func frames() {
        let outcome = DeviceProbes.displayOutcome(stats(frames: 41, surfaces: 1), surfaceSize: "1206x2622", waitMs: 1500, selection: "port 2 of 3")
        guard case .passed(.device, let note, let framesSeen) = outcome else {
            Issue.record("expected a device-level pass, got \(outcome)")
            return
        }
        #expect(framesSeen == 41)
        #expect(note?.contains("41 frame callbacks") == true)
    }

    @Test("a surface with no frame while it waited is surfaceOnly, never a device-level pass")
    func surfaceOnly() {
        let outcome = DeviceProbes.displayOutcome(stats(frames: 0, surfaces: 1), surfaceSize: "1206x2622", waitMs: 1500, selection: "port 2 of 3")
        guard case .passed(.surfaceOnly, _, let framesSeen) = outcome else {
            Issue.record("expected surfaceOnly, got \(outcome)")
            return
        }
        #expect(framesSeen == 0)
    }

    @Test("no callback at all, or frames without a surface, fail at device level")
    func failures() {
        #expect(DeviceProbes.displayOutcome(stats(frames: 0, surfaces: 0), surfaceSize: "1206x2622", waitMs: 1500, selection: "")
            == .failed(checked: .device, reason: "no screen callback within 1500 ms (surface 1206x2622)"))
        guard case .failed(.device, _) = DeviceProbes.displayOutcome(stats(frames: 3, surfaces: 0), surfaceSize: nil, waitMs: 1500, selection: "") else {
            Issue.record("frames without a surface must fail")
            return
        }
    }

    @Test("the verdict carries framesSeen into the report")
    func verdictCarriesFrames() {
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: nil, lookup: [.display: .implementation("screenCallbacks"), .screenshot: .implementation("surface")],
            frameworkLoadFailure: nil,
            probes: [.display: .passed(checked: .surfaceOnly, note: "static", framesSeen: 0), .screenshot: .passed(checked: .device, note: nil)]))
        #expect(reports[.display] == CapabilityReport(
            status: .ok, implementation: "screenCallbacks", checked: .surfaceOnly, reason: nil, note: "static", framesSeen: 0))
        #expect(reports[.screenshot]?.framesSeen == nil)
    }

    @Test("two self-tests running at once never share a temporary file")
    func temporaryNames() {
        let paths = (0..<4).map { _ in DeviceProbes.temporaryImagePath("selftest") }
        #expect(Set(paths).count == 4)
        #expect(paths.allSatisfy { $0.hasPrefix(FileManager.default.temporaryDirectory.path) && $0.hasSuffix(".png") })
    }
}
