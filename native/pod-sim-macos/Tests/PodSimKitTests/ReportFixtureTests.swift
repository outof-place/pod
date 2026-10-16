import Foundation
import Testing
@testable import PodSimKit

/// The runtime client decodes these same fixture results with its zod schemas, so a field renamed
/// on one side turns one of the two suites red.
@Suite("Result shapes")
struct ReportFixtureTests {
    private func fixtureResults() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/protocol-v1.json")
        let root = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try #require(root["results"] as? [String: Any])
    }

    private func roundTrips<T: Codable>(_ type: T.Type, _ key: String) throws {
        let fixture = try #require(try fixtureResults()[key])
        let decoded = try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: fixture))
        let encoded = try JSONSerialization.jsonObject(with: WireJSON.encoder.encode(decoded))
        #expect(NSDictionary(dictionary: encoded as? [String: Any] ?? [:]).isEqual(to: fixture as? [String: Any] ?? ["missing": key]))
    }

    @Test("self-test reports keep the fixture's shape and its optional keys, no null keys",
          arguments: ["hello", "selftestUnknownBuild", "selftestDevice", "selftestStaticScreen", "selftestInput", "selftestAxUnknownTranslator"])
    func reports(_ key: String) throws {
        try roundTrips(SelftestReport.self, key)
    }

    @Test("display and screenshot results keep the fixture's shape and its optional keys",
          arguments: ["attachDisplay", "displayStats", "screenshot", "screenshotSimctl"])
    func results(_ key: String) throws {
        switch key {
        case "attachDisplay": try roundTrips(AttachDisplayResult.self, key)
        case "displayStats": try roundTrips(DisplayStats.self, key)
        default: try roundTrips(ScreenshotResult.self, key)
        }
    }

    @Test("hid and ax results keep the fixture's shape and its optional keys",
          arguments: ["hidTap", "hidText", "hidPasteAlert", "hidDegraded", "ax", "axDegraded"])
    func inputResults(_ key: String) throws {
        if key.hasPrefix("ax") { try roundTrips(AXSnapshotResult.self, key) } else { try roundTrips(HIDResult.self, key) }
    }
}
