import Foundation
import Testing
@testable import PodSimKit

@Suite("Selftest verdicts")
struct SelftestVerdictsTests {
    let known: [Capability: TableVerdict] = [
        .display: .implementation("screenCallbacks"),
        .screenshot: .implementation("surface"),
        .hid: .unsupported("not in this helper yet"),
        .ax: .unsupported("not in this helper yet"),
    ]

    @Test("no usable Xcode makes every capability unsupported with the reason, and nothing is attempted")
    func environmentProblem() {
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: "no Xcode: xcode-select -p printed /Library/Developer/CommandLineTools",
            lookup: nil, frameworkLoadFailure: nil, probes: [:]))
        for capability in Capability.allCases {
            #expect(reports[capability] == CapabilityReport(
                status: .unsupported, implementation: nil, checked: .table,
                reason: "no Xcode: xcode-select -p printed /Library/Developer/CommandLineTools", note: nil))
        }
    }

    @Test("a capability the table leaves out is unsupported even when its probe would pass")
    func tableDecidesFirst() {
        var lookup = known
        lookup[.display] = .unsupported("CoreSimulator 1200.1 with SimulatorKit 1050.3 is not in the version table")
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: nil, lookup: lookup, frameworkLoadFailure: nil,
            probes: [.display: .passed(checked: .device, note: "surface 1206x2622"), .screenshot: .passed(checked: .symbols, note: nil)]))
        #expect(reports[.display] == CapabilityReport(
            status: .unsupported, implementation: nil, checked: .table,
            reason: "CoreSimulator 1200.1 with SimulatorKit 1050.3 is not in the version table", note: nil))
        #expect(reports[.screenshot]?.status == .ok)
    }

    @Test("frameworks that do not load fail every capability the table picked, and only those")
    func loadFailure() {
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: nil, lookup: known,
            frameworkLoadFailure: "dlopen SimulatorKit: code signature not valid for use in process",
            probes: [:]))
        #expect(reports[.display] == CapabilityReport(
            status: .failed, implementation: "screenCallbacks", checked: .symbols,
            reason: "dlopen SimulatorKit: code signature not valid for use in process", note: nil))
        #expect(reports[.screenshot]?.status == .failed)
        #expect(reports[.hid]?.status == .unsupported)
    }

    @Test("probe outcomes become ok or failed at the level they reached")
    func probes() {
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: nil, lookup: known, frameworkLoadFailure: nil,
            probes: [
                .display: .passed(checked: .device, note: "surface 1206x2622, 1 surface callback, 0 frames in 1000 ms"),
                .screenshot: .failed(checked: .symbols, reason: "SimDevice has no -io"),
            ]))
        #expect(reports[.display] == CapabilityReport(
            status: .ok, implementation: "screenCallbacks", checked: .device,
            reason: nil, note: "surface 1206x2622, 1 surface callback, 0 frames in 1000 ms"))
        #expect(reports[.screenshot] == CapabilityReport(
            status: .failed, implementation: "surface", checked: .symbols, reason: "SimDevice has no -io", note: nil))
    }

    @Test("a picked capability nobody probed is failed, never silently ok")
    func unprobed() {
        let reports = SelftestVerdicts.compose(VerdictInputs(
            environmentProblem: nil, lookup: known, frameworkLoadFailure: nil, probes: [.display: .passed(checked: .symbols, note: nil)]))
        #expect(reports[.screenshot] == CapabilityReport(
            status: .failed, implementation: "surface", checked: .table, reason: "not checked", note: nil))
    }
}
