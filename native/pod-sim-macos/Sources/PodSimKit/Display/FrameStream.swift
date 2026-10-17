import CPodSimSurface
import Foundation
import IOSurface

public struct StreamStats: Codable, Equatable, Sendable {
    public let token: UInt32
    /// Frame messages delivered, and those the viewer's full queue refused (a later frame follows).
    public let framesSent: Int
    public let framesDropped: Int
    /// Surface messages delivered: at start, after a surface change, and on a retry.
    public let surfaceSends: Int
    /// The last frame number sent.
    public let seq: UInt64
}

/// One viewer of a device: its launchd rendezvous, token and nonce. Touched only on the attachment's
/// queue. A viewer whose port died ends the stream (`ended`); the attachment drops it at once.
final class FrameStream: @unchecked Sendable {
    /// The ui-host `simAttach` token's range (src/main/pod/sim-pane/pod-sim-pane-protocol.ts).
    static let tokenRange: ClosedRange<UInt32> = 1...2_147_483_647
    /// A full viewer queue is tried again with the newest frame after 8 ms, doubling, about 1 s in
    /// all: a viewer that stays full that long is stuck, and the next frame tries again.
    static let retryDelaysMs = [8, 16, 32, 64, 128, 256, 512]

    enum Delivery: Equatable { case sent, full, ended }

    let token: UInt32
    /// The `startStream` nonce every message carries; the viewer keeps only messages with its own.
    let nonce: UInt64
    let service: String
    private let sender: OpaquePointer
    private(set) var seq: UInt64 = 0
    private var framesSent = 0
    private var framesDropped = 0
    private var surfaceSends = 0
    /// The surface id the viewer was last given; a frame waits until it has one.
    private var deliveredSurface: UInt32?
    private(set) var ended: String?
    /// Index into retryDelaysMs of the retry waiting, nil when none is.
    var retryAttempt: Int?

    private init(token: UInt32, nonce: UInt64, service: String, sender: OpaquePointer) {
        self.token = token
        self.nonce = nonce
        self.service = service
        self.sender = sender
    }

    deinit { pod_sim_sender_destroy(sender) }

    static func open(service: String, token: UInt32, nonce: UInt64) -> Result<FrameStream, HelperError> {
        var error: Int32 = 0
        guard let sender = pod_sim_sender_create(service, token, nonce, &error) else {
            return .failure(HelperError(.failed, "no viewer has checked in \(service) (bootstrap_look_up \(error))"))
        }
        return .success(FrameStream(token: token, nonce: nonce, service: service, sender: sender))
    }

    /// `startStream`'s nonce on the wire: 16 lowercase hex digits, not all zero.
    static func nonce(_ text: String) -> UInt64? {
        guard text.utf8.count == 16, text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let value = UInt64(text, radix: 16), value != 0
        else { return nil }
        return value
    }

    static func nonceText(_ value: UInt64) -> String {
        let hex = String(value, radix: 16)
        return String(repeating: "0", count: 16 - hex.count) + hex
    }

    /// Hands the viewer `surface`.
    @discardableResult
    func sendSurface(_ surface: IOSurfaceRef, scaleX100: UInt32) -> Delivery {
        guard ended == nil else { return .ended }
        let status = pod_sim_sender_send_surface(sender, Unmanaged.passUnretained(surface).toOpaque(), seq, scaleX100)
        let delivery = outcome(status)
        if delivery == .sent {
            surfaceSends += 1
            deliveredSurface = IOSurfaceGetID(surface)
        }
        return delivery
    }

    /// The newest frame; on `full` the caller retries once later.
    func sendFrame(surface: IOSurfaceRef, seed: UInt32, scaleX100: UInt32, advance: Bool) -> Delivery {
        guard ended == nil else { return .ended }
        if advance { seq += 1 }
        let id = IOSurfaceGetID(surface)
        if deliveredSurface != id {
            let delivery = sendSurface(surface, scaleX100: scaleX100)
            if delivery != .sent {
                if delivery == .full, advance { framesDropped += 1 }
                return delivery
            }
        }
        let width = Int32(clamping: IOSurfaceGetWidth(surface)), height = Int32(clamping: IOSurfaceGetHeight(surface))
        let delivery = outcome(pod_sim_sender_send_frame(sender, seq, id, seed, 0, 0, 0, width, height))
        switch delivery {
        case .sent: framesSent += 1
        case .full: if advance { framesDropped += 1 }
        case .ended: break
        }
        return delivery
    }

    /// The viewer will be given the surface again with the next frame (a restart, an adopted stream).
    func forgetSurface() { deliveredSurface = nil }

    func stats() -> StreamStats {
        StreamStats(token: token, framesSent: framesSent, framesDropped: framesDropped, surfaceSends: surfaceSends, seq: seq)
    }

    private func outcome(_ status: Int32) -> Delivery {
        switch status {
        case KERN_SUCCESS: return .sent
        case MACH_SEND_TIMED_OUT, MACH_SEND_NO_BUFFER, MACH_SEND_INTERRUPTED: return .full
        default:
            if ended == nil {
                ended = status == MACH_SEND_INVALID_DEST ? "the viewer is gone" : "mach_msg \(status)"
                HelperLog.note("stream \(token) to \(service) ended: \(ended!)")
            }
            return .ended
        }
    }
}
