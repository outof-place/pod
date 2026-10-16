import Foundation
import Testing
@testable import PodSimKit

/// The shared wire fixture (also decoded by the runtime client's tests in src/main/pod/sim/helper).
struct ProtocolFixture: Decodable {
    struct Exchange: Decodable, CustomTestStringConvertible {
        struct Send: Decodable { let line: String?; let oversizedBytes: Int? }
        struct Expect: Decodable { let id: Int?; let error: String?; let result: String? }
        let name: String
        let token: String
        let send: [Send]
        let expect: [Expect]
        var testDescription: String { name }
    }
    let `protocol`: Int
    let maxFrameBytes: Int
    let errorCodes: [String]
    let methods: [String]
    let capabilities: [String]
    let verdicts: [String]
    let deadlinesMs: [String: Int]
    let checkLevels: [String]
    let exchanges: [Exchange]

    static func load() throws -> ProtocolFixture {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/protocol-v1.json")
        return try JSONDecoder().decode(ProtocolFixture.self, from: Data(contentsOf: url))
    }

    static var exchangeCases: [Exchange] { (try? load().exchanges) ?? [] }
}

/// Answers every known method with an empty result, synchronously.
private struct EchoHandler: MethodHandler {
    let methods: Set<String>
    func helloResult() -> Data { Data(#"{"protocol":1}"#.utf8) }
    func handle(_ request: Request, reply: @escaping @Sendable (Reply) -> Void) -> Bool {
        guard methods.contains(request.method) else { return false }
        reply(.result(Data("{}".utf8)))
        return true
    }
}

private final class Outbox: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []
    func append(_ data: Data) { lock.withLock { frames.append(data) } }
    var all: [Data] { lock.withLock { frames } }
}

@Suite("Protocol session")
struct ProtocolSessionTests {
    @Test("the wire constants match the shared fixture")
    func constants() throws {
        let fixture = try ProtocolFixture.load()
        #expect(HelperProtocol.version == fixture.protocol)
        #expect(HelperProtocol.maxFrameBytes == fixture.maxFrameBytes)
        #expect(HelperErrorCode.allCases.map(\.rawValue) == fixture.errorCodes)
        #expect(Capability.allCases.map(\.rawValue) == fixture.capabilities)
        #expect(Verdict.allCases.map(\.rawValue) == fixture.verdicts)
        #expect(HelperProtocol.deadlinesMs == fixture.deadlinesMs)
        #expect(Set(HelperProtocol.deadlinesMs.keys) == Set(fixture.methods.filter { $0 != "hello" }))
        #expect(CheckLevel.allCases.map(\.rawValue) == fixture.checkLevels)
    }

    @Test("fixture exchange", arguments: ProtocolFixture.exchangeCases)
    func exchange(_ exchange: ProtocolFixture.Exchange) throws {
        let fixture = try ProtocolFixture.load()
        let outbox = Outbox()
        let session = ProtocolSession(
            token: exchange.token,
            handler: EchoHandler(methods: Set(fixture.methods)),
            send: { outbox.append($0) })
        var framer = LineFramer(maxFrameBytes: HelperProtocol.maxFrameBytes)
        for item in exchange.send {
            var bytes = Array((item.line ?? "").utf8)
            if let count = item.oversizedBytes { bytes = Array(repeating: UInt8(ascii: "x"), count: count) }
            for event in framer.push(bytes + [0x0A]) { session.receive(event) }
        }

        let replies = try outbox.all.map { data -> [String: Any] in
            #expect(data.last == 0x0A, "every frame ends with a newline")
            #expect(!data.dropLast().contains(0x0A), "a frame is one line")
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        #expect(replies.count == exchange.expect.count)
        for (reply, expected) in zip(replies, exchange.expect) {
            #expect(reply.keys.contains("id"), "every reply names its id, null when unknown")
            #expect((reply["id"] as? Int) == expected.id)
            if let code = expected.error {
                let error = try #require(reply["error"] as? [String: Any])
                #expect(error["code"] as? String == code)
                #expect(((error["message"] as? String) ?? "").isEmpty == false)
            } else {
                #expect(reply["result"] is [String: Any])
            }
        }
    }
}

/// `slow` outlives its deadline, `fast` answers at once, `huge` answers `bytes` of JSON: each through
/// the helper's deadline dispatcher, as HelperMethods runs them.
private struct TimedHandler: MethodHandler {
    let dispatcher = DeadlineDispatcher()
    let slowDone = Outbox()
    let hugeBytes: Int

    init(hugeBytes: Int = 0) { self.hugeBytes = hugeBytes }

    func helloResult() -> Data { Data(#"{"protocol":1}"#.utf8) }
    func handle(_ request: Request, reply: @escaping @Sendable (Reply) -> Void) -> Bool {
        let done = slowDone
        let bytes = hugeBytes
        switch request.method {
        case "slow":
            dispatcher.run("slow", deadlineMs: 100, {
                usleep(400_000)
                done.append(Data("finished".utf8))
                return .result(Data(#"{"late":true}"#.utf8))
            }, reply: reply)
        case "fast":
            dispatcher.run("fast", deadlineMs: 1_000, { .result(Data(#"{"fast":true}"#.utf8)) }, reply: reply)
        case "huge":
            // {"x":"xxx...x"}: 8 bytes of wrapping around the filler.
            dispatcher.run("huge", deadlineMs: 1_000, {
                .result(Data(#"{"x":""#.utf8) + Data(repeating: UInt8(ascii: "x"), count: bytes - 8) + Data(#""}"#.utf8))
            }, reply: reply)
        default: return false
        }
        return true
    }
}

private func lines(_ text: String...) -> [UInt8] {
    Array(text.map { $0 + "\n" }.joined().utf8)
}

private func waitFor(_ outbox: Outbox, count: Int, within seconds: Double) -> [[String: Any]] {
    let end = Date().addingTimeInterval(seconds)
    while outbox.all.count < count, Date() < end { usleep(10_000) }
    return outbox.all.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
}

@Suite("Deadlines and outgoing frames")
struct HelperDeadlineTests {
    let token = "5f3a9c0e4b7d21865f3a9c0e4b7d2186"
    var hello: String { #"{"id":1,"method":"hello","params":{"token":"\#(token)","protocol":1}}"# }

    private func makeSession(_ handler: TimedHandler, _ outbox: Outbox) -> (ProtocolSession, LineFramer) {
        (ProtocolSession(token: token, handler: handler, send: { outbox.append($0) }), LineFramer(maxFrameBytes: HelperProtocol.maxFrameBytes))
    }

    @Test("a method past its deadline is answered timeout by the helper, which goes on serving, and its late result is dropped")
    func slowMethodTimesOut() {
        let outbox = Outbox(), handler = TimedHandler()
        let (session, initial) = makeSession(handler, outbox)
        var framer = initial
        let started = Date()
        for event in framer.push(lines(hello, #"{"id":2,"method":"slow"}"#)) { session.receive(event) }
        let early = waitFor(outbox, count: 2, within: 2)
        #expect(Date().timeIntervalSince(started) < 0.35, "answered at the deadline, not when the work ended")
        #expect((early.last?["error"] as? [String: Any])?["code"] as? String == "timeout")
        #expect(early.last?["id"] as? Int == 2)

        for event in framer.push(lines(#"{"id":3,"method":"fast"}"#)) { session.receive(event) }
        let served = waitFor(outbox, count: 3, within: 2)
        #expect(served.last?["id"] as? Int == 3)
        #expect((served.last?["result"] as? [String: Any])?["fast"] as? Bool == true)

        _ = waitFor(handler.slowDone, count: 1, within: 2)
        usleep(50_000)
        #expect(outbox.all.count == 3, "one reply per request: the late result never goes out")
    }

    @Test("replies leave in the order they finish, each with its own id")
    func outOfOrder() {
        let outbox = Outbox(), handler = TimedHandler()
        let (session, initial) = makeSession(handler, outbox)
        var framer = initial
        for event in framer.push(lines(hello, #"{"id":2,"method":"slow"}"#, #"{"id":3,"method":"fast"}"#)) { session.receive(event) }
        let replies = waitFor(outbox, count: 3, within: 2)
        #expect(replies.map { $0["id"] as? Int } == [1, 3, 2])
    }

    @Test("a reply over the frame limit goes out as frameTooLarge for its id; one at the limit goes out whole",
          arguments: [false, true])
    func outgoingCap(over: Bool) throws {
        // {"id":2,"result":<body>}: 18 bytes around the body.
        let body = HelperProtocol.maxFrameBytes - 18 + (over ? 1 : 0)
        let outbox = Outbox(), handler = TimedHandler(hugeBytes: body)
        let (session, initial) = makeSession(handler, outbox)
        var framer = initial
        for event in framer.push(lines(hello, #"{"id":2,"method":"huge"}"#)) { session.receive(event) }
        _ = waitFor(outbox, count: 2, within: 5)
        let frame = try #require(outbox.all.last)
        #expect(frame.count - 1 <= HelperProtocol.maxFrameBytes)
        let reply = try #require(try JSONSerialization.jsonObject(with: frame) as? [String: Any])
        #expect(reply["id"] as? Int == 2)
        if over {
            #expect((reply["error"] as? [String: Any])?["code"] as? String == "frameTooLarge")
        } else {
            #expect(frame.count - 1 == HelperProtocol.maxFrameBytes)
            #expect(reply["result"] is [String: Any])
        }
    }
}
