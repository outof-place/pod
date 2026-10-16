import Foundation
import Testing
@testable import PodSimKit

/// When the version table has no private path, `hid` and `ax` go to the public fallback by UDID,
/// before any device lookup: with the table unknown CoreSimulator is not loaded at all.
@Suite("Public fallback seam")
struct FallbackSeamTests {
    private static let udid = "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0"
    private static let environment = [
        "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer", "POD_SIM_FORCE_UNKNOWN_BUILD": "1",
    ]
    private static let tableReason = "treated as unknown (POD_SIM_FORCE_UNKNOWN_BUILD=1)"

    private struct TapThroughDriver: PublicInputFallback {
        func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
            .success(HIDResult(udid: udid, kind: action.kind, ms: 1, via: nil, typed: nil, frameAfterMs: nil, degraded: nil))
        }
    }

    private struct TreeThroughDriver: PublicAccessibilityFallback {
        func snapshot(udid: String, options: AXSnapshotOptions) -> Result<AXSnapshotResult, HelperError> {
            .success(AXSnapshotResult(
                udid: udid, screen: AXScreen(width: 402, height: 874, scale: 3), app: nil, nodes: [], total: 0, shown: 0, omitted: 0,
                notVisible: 0, alertSuspected: false, fingerprint: "0000000000000000", ms: 1, transport: "bridge"))
        }
    }

    private func error(_ reply: Reply) -> HelperError? {
        if case .error(let error) = reply { return error }
        return nil
    }

    @Test("without a fallback, hid and ax say why: the table's reason, then the missing driver")
    func refusesWithReasons() {
        let unknown = HelperMethods(environment: Self.environment)
        let tap = error(unknown.hid(Data(#"{"udid":"\#(Self.udid)","action":{"kind":"tap","x":10,"y":10}}"#.utf8)))
        #expect(tap?.code == .unsupported)
        #expect(tap?.message == "hid: \(Self.tableReason); no public input fallback in this helper (an XCTest driver is owed)")
        let snapshot = error(unknown.ax(Data(#"{"udid":"\#(Self.udid)"}"#.utf8)))
        #expect(snapshot?.code == .unsupported)
        #expect(snapshot?.message.hasPrefix("ax: \(Self.tableReason); no public accessibility fallback") == true)
    }

    @Test("a fallback that acts answers in place of the private path, and the seam marks it degraded with the table's reason")
    func fallbackAnswersDegraded() throws {
        let methods = HelperMethods(environment: Self.environment, inputFallback: TapThroughDriver(), accessibilityFallback: TreeThroughDriver())
        guard case .result(let tapData) = methods.hid(Data(#"{"udid":"\#(Self.udid)","action":{"kind":"tap","x":10,"y":10}}"#.utf8)) else {
            Issue.record("hid: expected a result")
            return
        }
        let tap = try JSONDecoder().decode(HIDResult.self, from: tapData)
        #expect(tap.degraded == "hid: \(Self.tableReason)")
        #expect(tap.udid == Self.udid)
        guard case .result(let treeData) = methods.ax(Data(#"{"udid":"\#(Self.udid)"}"#.utf8)) else {
            Issue.record("ax: expected a result")
            return
        }
        #expect(try JSONDecoder().decode(AXSnapshotResult.self, from: treeData).degraded == "ax: \(Self.tableReason)")
    }
}
