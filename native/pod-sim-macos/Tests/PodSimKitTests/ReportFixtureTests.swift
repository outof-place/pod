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

    private func fixtureEvents() throws -> [String: Any] {
        try #require(fixtureRoot()["events"] as? [String: Any])
    }

    private func fixtureRoot() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/protocol-v1.json")
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func roundTrips<T: Codable>(_ type: T.Type, _ key: String, events: Bool = false) throws {
        let fixture = try #require(try (events ? fixtureEvents() : fixtureResults())[key])
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
          arguments: ["attachDisplay", "displayStats", "displayStatsStreaming", "screenshot", "screenshotSimctl", "startStream", "stopStream"])
    func results(_ key: String) throws {
        switch key {
        case "attachDisplay": try roundTrips(AttachDisplayResult.self, key)
        case "displayStats", "displayStatsStreaming": try roundTrips(DisplayStats.self, key)
        case "startStream": try roundTrips(StartStreamResult.self, key)
        case "stopStream": try roundTrips(StreamStats.self, key)
        default: try roundTrips(ScreenshotResult.self, key)
        }
    }

    @Test("settle results, the Xcode choice and the events keep the fixture's shape",
          arguments: ["settle", "settleWithMotion", "xcodeChosen", "inputWedged", "streamEnded"])
    func stageTwoBShapes(_ key: String) throws {
        switch key {
        case "xcodeChosen": try roundTrips(XcodeInfo.self, key)
        case "inputWedged": try roundTrips(InputWedgedEvent.self, key, events: true)
        case "streamEnded": try roundTrips(StreamEndedEvent.self, key, events: true)
        default: try roundTrips(SettleResult.self, key)
        }
    }

    @Test("the stream end reasons and the stream requests are the runtime's")
    func streamVocabulary() throws {
        let root = try fixtureRoot()
        #expect(StreamEndReason.allCases.map(\.rawValue) == root["streamEndReasons"] as? [String])
        let requests = try #require(root["requests"] as? [String: Any])
        let start = try JSONDecoder().decode(
            HelperMethods.StartStreamParams.self, from: JSONSerialization.data(withJSONObject: try #require(requests["startStream"])))
        #expect(start.token == 1_953 && FrameStream.nonce(start.nonce) == 0x9e37_79b9_7f4a_7c15)
        let stop = try JSONDecoder().decode(
            HelperMethods.StopStreamParams.self, from: JSONSerialization.data(withJSONObject: try #require(requests["stopStream"])))
        #expect(stop.nonce == start.nonce)
    }

    @Test("ax params decode the runtime's request, the fresh flag included")
    func axParams() throws {
        let requests = try #require(fixtureRoot()["requests"] as? [String: Any])
        let params = try JSONDecoder().decode(AXParams.self, from: JSONSerialization.data(withJSONObject: try #require(requests["ax"])))
        #expect(params.fresh == true && params.hitTest == true && params.filter == "book" && params.maxNodes == 60)
    }

    @Test("hid and ax results keep the fixture's shape and its optional keys",
          arguments: ["hidTap", "hidText", "hidPasteAlert", "hidDegraded", "ax", "axCached", "axTranslatorFallback", "axDegraded"])
    func inputResults(_ key: String) throws {
        if key.hasPrefix("ax") { try roundTrips(AXSnapshotResult.self, key) } else { try roundTrips(HIDResult.self, key) }
    }
}
