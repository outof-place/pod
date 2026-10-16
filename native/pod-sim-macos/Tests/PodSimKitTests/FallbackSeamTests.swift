import Foundation
import Testing
@testable import PodSimKit

/// When the version table has no private path, `hid` and `ax` go to the public fallback by UDID,
/// before any device lookup: with the table unknown CoreSimulator is not loaded at all.
@Suite("Public fallback seam")
struct FallbackSeamTests {
    private static let udid = "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0"
    private let unknown = HelperMethods(environment: [
        "DEVELOPER_DIR": "/Applications/Xcode.app/Contents/Developer", "POD_SIM_FORCE_UNKNOWN_BUILD": "1",
    ])

    private struct TapThroughSimctl: PublicInputFallback {
        func hid(_ action: HIDAction, udid: String) -> Result<HIDResult, HelperError> {
            .success(HIDResult(udid: udid, kind: action.kind, ms: 1, via: nil, typed: nil, frameAfterMs: nil, degraded: "a public driver"))
        }
    }

    private func error(_ reply: Reply) -> HelperError? {
        if case .error(let error) = reply { return error }
        return nil
    }

    @Test("without a fallback, hid and ax say why: the table's reason, then the missing driver")
    func refusesWithReasons() {
        let tap = error(unknown.hid(Data(#"{"udid":"\#(Self.udid)","action":{"kind":"tap","x":10,"y":10}}"#.utf8)))
        #expect(tap?.code == .unsupported)
        #expect(tap?.message == "hid: treated as unknown (POD_SIM_FORCE_UNKNOWN_BUILD=1); no public input fallback in this helper (an XCTest driver is owed)")
        let snapshot = error(unknown.ax(Data(#"{"udid":"\#(Self.udid)"}"#.utf8)))
        #expect(snapshot?.code == .unsupported)
        #expect(snapshot?.message.hasPrefix("ax: treated as unknown (POD_SIM_FORCE_UNKNOWN_BUILD=1); no public accessibility fallback") == true)
    }

    @Test("a fallback that can act answers in place of the private path, marked degraded")
    func fallbackAnswers() throws {
        let reply = unknown.hid(Data(#"{"udid":"\#(Self.udid)","action":{"kind":"tap","x":10,"y":10}}"#.utf8), fallback: TapThroughSimctl())
        guard case .result(let data) = reply else {
            Issue.record("expected a result, got \(String(describing: error(reply)))")
            return
        }
        let result = try JSONDecoder().decode(HIDResult.self, from: data)
        #expect(result.degraded == "a public driver")
        #expect(result.udid == Self.udid)
    }
}
