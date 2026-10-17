import Foundation

/// Protocol v1 between Pod's runtime and pod-sim: newline-delimited JSON over the helper's stdio.
/// Frozen for stages 2b, 3, 4, 7 and 8 in README.md and Fixtures/protocol-v1.json.
public enum HelperProtocol {
    public static let version = 1
    /// Bytes before the newline, both directions.
    public static let maxFrameBytes = 1_048_576
    /// The per-spawn token the runtime puts in the helper's environment; `hello` must carry it.
    public static let tokenEnvironmentKey = "POD_SIM_TOKEN"
    /// Each method's deadline: past it the helper answers `timeout` itself, and the runtime recycles
    /// only a helper silent past its deadline plus a margin.
    public static let deadlinesMs: [String: Int] = [
        // waitMs (at most 10 s) for frames, the framebuffer read and the simctl fallback (6 s cap).
        "selftest": 20_000,
        "attachDisplay": 5_000,
        "displayStats": 2_000,
        "detachDisplay": 5_000,
        // An attach (a dozen remote calls) and the viewer's name lookup.
        "startStream": 5_000,
        "stopStream": 2_000,
        // timeoutMs (at most 20 s) plus the accessibility read under way when it passes.
        "settle": 25_000,
        // The framebuffer read, else `simctl io screenshot` (6 s cap).
        "screenshot": 8_000,
        // Connecting (a 4 s liveness reply at most) plus an action of at most 10 s (HIDLimits).
        "hid": 15_000,
        // A 2.5 s walk budget plus one request in flight; the first call also loads the translator.
        "ax": 5_000,
    ]
    /// `simctl` children end before the methods that wait on them reach their deadline.
    static let simctlTimeout: TimeInterval = 6
}

public enum HelperErrorCode: String, CaseIterable, Codable, Sendable {
    case badFrame, frameTooLarge, helloRequired, tokenMismatch, protocolMismatch, unknownMethod, badParams
    /// The version table has no implementation of this capability for the builds the helper saw.
    case unsupported
    /// The table picked an implementation, and it failed here (a moved symbol, no surface).
    case failed
    case deviceNotFound, deviceNotBooted, notAttached, writeFailed, simctlFailed
    /// Past the method's deadline: the work may still have reached the device (`hid`: read state before retrying).
    case timeout
    /// The device's `hid` lane is full (InputLanes.maxDepth); nothing was sent.
    case busy
    /// The call waited behind one stuck in a private call, and the lane was given up on; nothing was sent.
    case wedged
    case `internal`
}

public struct HelperError: Error, Equatable, Sendable {
    public let code: HelperErrorCode
    public let message: String

    public init(_ code: HelperErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

public enum Capability: String, CaseIterable, Codable, Sendable {
    case display, screenshot, hid, ax
}

public enum Verdict: String, CaseIterable, Codable, Sendable {
    case ok, unsupported, failed
}

/// One request after framing; `params` is the encoded JSON object (`{}` when absent).
public struct Request: Sendable {
    public let id: Int
    public let method: String
    public let params: Data
}

public enum Reply: Sendable {
    /// An encoded JSON object.
    case result(Data)
    case error(HelperError)

    public static func encoding(_ value: some Encodable) -> Reply {
        do {
            return .result(try WireJSON.encoder.encode(value))
        } catch {
            return .error(HelperError(.internal, "could not encode the result: \(error)"))
        }
    }
}

public protocol MethodHandler: Sendable {
    /// The `hello` result: versions and the start-up self-test.
    func helloResult() -> Data
    /// False when `request.method` is unknown; otherwise `reply` is called once, on any thread.
    func handle(_ request: Request, reply: @escaping @Sendable (Reply) -> Void) -> Bool
}

enum WireJSON {
    static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    static func decode<T: Decodable>(_ type: T.Type, from params: Data) -> Result<T, HelperError> {
        do {
            return .success(try JSONDecoder().decode(type, from: params))
        } catch {
            return .failure(HelperError(.badParams, describe(error)))
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? DecodingError {
        case .keyNotFound(let key, _): return "missing \(key.stringValue)"
        case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? context.debugDescription : "bad \(path): \(context.debugDescription)"
        default: return "\(error)"
        }
    }
}
