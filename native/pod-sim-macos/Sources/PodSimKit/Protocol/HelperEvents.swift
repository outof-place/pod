import Foundation

/// Lines the helper sends unasked, `{"event": name, "params": {...}}` with no id. The session that
/// listens writes them once `hello` succeeded; until then they are dropped.
public final class HelperEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (String, Data) -> Void)?

    public init() {}

    public func listen(_ sink: @escaping @Sendable (_ name: String, _ params: Data) -> Void) {
        lock.withLock { self.sink = sink }
    }

    func emit(_ name: String, _ params: some Encodable) {
        guard let sink = lock.withLock({ sink }), let body = try? WireJSON.encoder.encode(params) else { return }
        sink(name, body)
    }
}

/// `inputWedged`: a device's `hid` lane was given up on (InputLanes). The device's input connection
/// was dropped and its next call runs on a fresh lane. `recycleAdvised`: enough threads are stuck in
/// private calls that the runtime should replace the helper (with its usual backoff).
struct InputWedgedEvent: Codable, Equatable, Sendable {
    let udid: String
    let stuckMs: Int
    /// Calls answered `wedged` without being sent.
    let dropped: Int
    /// Lanes given up on since the helper started.
    let abandoned: Int
    let recycleAdvised: Bool
}

/// Why a stream ended without a `stopStream`. The runtime adds `helperRestart` of its own for a view
/// a replacement helper refused to stream again; the helper never sends it.
public enum StreamEndReason: String, CaseIterable, Codable, Sendable {
    /// The viewer's port is dead (its process quit, or it gave the name up): forget the view.
    case viewerGone
    /// The device is no longer booted: start the view again only after booting it.
    case deviceShutDown
    /// The device booted again and its display was replaced: call `startStream` again.
    case deviceRebooted
    /// `detachDisplay` ended the display (a pool reset): call `startStream` again to keep showing it.
    case detached
}

/// `streamEnded`: one stream ended without a `stopStream`. `nonce` names the stream's generation, so
/// a view started again under the same token is not mistaken for the one that ended.
struct StreamEndedEvent: Codable, Equatable, Sendable {
    let udid: String
    let token: UInt32
    let nonce: String
    let reason: StreamEndReason
}
