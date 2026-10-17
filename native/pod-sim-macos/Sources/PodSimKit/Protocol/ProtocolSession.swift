import Foundation

/// One stdio session: parses frames, holds every request back until a `hello` carries this spawn's
/// token, and writes each reply as one line. Replies may come out of order; the runtime matches ids.
public final class ProtocolSession: @unchecked Sendable {
    private let token: Data
    private let handler: any MethodHandler
    private let send: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var authenticated = false

    public init(token: String, handler: any MethodHandler, send: @escaping @Sendable (Data) -> Void) {
        self.token = Data(token.utf8)
        self.handler = handler
        self.send = send
    }

    public func receive(_ event: FramerEvent) {
        switch event {
        case .oversized(let count):
            reply(id: nil, .error(HelperError(.frameTooLarge, "a frame of \(count) bytes is over the \(HelperProtocol.maxFrameBytes)-byte limit")))
        case .frame(let data):
            switch Self.parse(data) {
            case .failure(let refusal): reply(id: refusal.id, .error(refusal.error))
            case .success(let request): dispatch(request)
            }
        }
    }

    private func dispatch(_ request: Request) {
        if request.method == "hello" {
            reply(id: request.id, hello(request.params))
            return
        }
        guard lock.withLock({ authenticated }) else {
            reply(id: request.id, .error(HelperError(.helloRequired, "send hello with this spawn's token first")))
            return
        }
        let id = request.id
        let known = handler.handle(request) { [weak self] outcome in self?.reply(id: id, outcome) }
        if !known {
            reply(id: id, .error(HelperError(.unknownMethod, "no method \(request.method) in protocol \(HelperProtocol.version)")))
        }
    }

    private struct HelloParams: Decodable {
        let token: String
        let `protocol`: Int
    }

    private func hello(_ params: Data) -> Reply {
        let decoded: HelloParams
        switch WireJSON.decode(HelloParams.self, from: params) {
        case .failure(let error): return .error(error)
        case .success(let value): decoded = value
        }
        guard Self.constantTimeEqual(Data(decoded.token.utf8), token) else {
            return .error(HelperError(.tokenMismatch, "the token is not this spawn's"))
        }
        guard decoded.protocol == HelperProtocol.version else {
            return .error(HelperError(.protocolMismatch, "this helper speaks protocol \(HelperProtocol.version), not \(decoded.protocol)"))
        }
        lock.withLock { authenticated = true }
        return .result(handler.helloResult())
    }

    /// An event line (HelperEvents); dropped before `hello` and when over the frame limit.
    public func emit(event name: String, params: Data) {
        guard lock.withLock({ authenticated }) else { return }
        var frame = Data("{\"event\":".utf8)
        frame.append((try? WireJSON.encoder.encode(name)) ?? Data("\"\"".utf8))
        frame.append(Data(",\"params\":".utf8))
        frame.append(params)
        frame.append(Data("}".utf8))
        guard frame.count <= HelperProtocol.maxFrameBytes else {
            HelperLog.note("event \(name) of \(frame.count) bytes is over the frame limit; dropped")
            return
        }
        frame.append(0x0A)
        send(frame)
    }

    private func reply(id: Int?, _ outcome: Reply) {
        var frame = Self.frame(id: id, outcome)
        // The limit holds both ways: a reply too big for the runtime to read becomes a typed error.
        if frame.count > HelperProtocol.maxFrameBytes {
            frame = Self.frame(id: id, .error(HelperError(
                .frameTooLarge, "the reply of \(frame.count) bytes is over the \(HelperProtocol.maxFrameBytes)-byte limit")))
        }
        frame.append(0x0A)
        send(frame)
    }

    private static func frame(id: Int?, _ outcome: Reply) -> Data {
        var frame = Data("{\"id\":".utf8)
        frame.append(Data((id.map(String.init) ?? "null").utf8))
        switch outcome {
        case .result(let body):
            frame.append(Data(",\"result\":".utf8))
            frame.append(body)
        case .error(let error):
            frame.append(Data(",\"error\":".utf8))
            frame.append((try? WireJSON.encoder.encode(ErrorBody(code: error.code, message: error.message))) ?? Data("{}".utf8))
        }
        frame.append(Data("}".utf8))
        return frame
    }

    private struct ErrorBody: Encodable {
        let code: HelperErrorCode
        let message: String
    }

    // MARK: - parsing

    private struct Refusal: Error {
        let id: Int?
        let error: HelperError
    }

    private static func parse(_ data: Data) -> Result<Request, Refusal> {
        guard let object = try? JSONSerialization.jsonObject(with: data), let fields = object as? [String: Any] else {
            return .failure(Refusal(id: nil, error: HelperError(.badFrame, "a frame is one JSON object")))
        }
        guard let id = requestID(fields["id"]) else {
            return .failure(Refusal(id: nil, error: HelperError(.badFrame, "id must be a non-negative integer")))
        }
        guard let method = fields["method"] as? String, !method.isEmpty else {
            return .failure(Refusal(id: id, error: HelperError(.badFrame, "method must be a string")))
        }
        let params: Data
        switch fields["params"] {
        case nil, is NSNull:
            params = Data("{}".utf8)
        case let object as [String: Any]:
            guard let encoded = try? JSONSerialization.data(withJSONObject: object) else {
                return .failure(Refusal(id: id, error: HelperError(.badParams, "params could not be read")))
            }
            params = encoded
        default:
            return .failure(Refusal(id: id, error: HelperError(.badParams, "params must be a JSON object")))
        }
        return .success(Request(id: id, method: method, params: params))
    }

    private static func requestID(_ value: Any?) -> Int? {
        // JSON true/false also arrive as NSNumber; only integers are ids.
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double >= 0, double <= 9_007_199_254_740_991, double.rounded() == double else { return nil }
        return number.intValue
    }

    private static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
