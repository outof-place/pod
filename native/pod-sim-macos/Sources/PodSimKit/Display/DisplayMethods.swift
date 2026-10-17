import Foundation
import IOSurface

public struct AttachDisplayResult: Codable, Equatable, Sendable {
    public struct Surface: Codable, Equatable, Sendable {
        public let width: Int
        public let height: Int
        public let id: UInt32
    }

    public let udid: String
    public let surface: Surface?
    public let alreadyAttached: Bool
}

public struct StartStreamResult: Codable, Equatable, Sendable {
    public let udid: String
    public let token: UInt32
    /// Absent while the display has no surface yet; it follows in a surface message.
    public let surface: AttachDisplayResult.Surface?
    /// Pixels per point.
    public let scale: Double
}

/// Per-device serialization of the calls that make, hold and release an attachment, so a stream
/// that stops never detaches a display another call is starting to use. Devices never wait on each other.
final class DeviceLocks: @unchecked Sendable {
    private let lock = NSLock()
    private var locks: [String: NSLock] = [:]

    func withLock<T>(_ udid: String, _ body: () -> T) -> T {
        let device = lock.withLock { () -> NSLock in
            if let existing = locks[udid] { return existing }
            let made = NSLock()
            locks[udid] = made
            return made
        }
        return device.withLock(body)
    }
}

/// `attachDisplay`, `detachDisplay`, `displayStats`, `startStream`, `stopStream`. An attachment is
/// held by `attachDisplay`, by each stream and by a running settle, and ends with the last hold;
/// `detachDisplay` ends it at once, streams included. A stream that ends without `stopStream` is
/// reported in a `streamEnded` event.
extension HelperMethods {
    /// PodNative's simulator rendezvous names (src/main/pod/sim-pane/pod-sim-pane-protocol.ts): frames
    /// go only to one of these.
    static let rendezvousPattern = try! NSRegularExpression(pattern: #"^codes\.pod\.native(\.dev)?\.sim\.[0-9a-f]{32}$"#)

    struct DeviceParams: Decodable {
        let udid: String
    }

    func attachDisplay(_ params: Data) -> Reply {
        decode(DeviceParams.self, params) { params in
            if let refusal = refusal(for: startupReport.capabilities.display, .display) { return .error(refusal) }
            let udid = params.udid.uppercased()
            return deviceLocks.withLock(udid) {
                switch ensureAttached(udid) {
                case .failure(let error): return .error(error)
                case .success(let (attachment, already)):
                    attachment.hold()
                    let surface = attachment.currentSurface.map(Self.describe)
                    return .encoding(AttachDisplayResult(udid: attachment.port.udid, surface: surface, alreadyAttached: already))
                }
            }
        }
    }

    func detachDisplay(_ params: Data) -> Reply {
        decode(DeviceParams.self, params) { params in
            let udid = params.udid.uppercased()
            return deviceLocks.withLock(udid) {
                switch displays.detach(udid) {
                case .failure(let error): return .error(error)
                case .success(let stats): return .encoding(stats)
                }
            }
        }
    }

    /// Counts of the attachment that still shows this boot's framebuffer: one whose device shut down
    /// or rebooted since is dropped here, so its counts never answer frozen.
    func displayStats(_ params: Data) -> Reply {
        decode(DeviceParams.self, params) { params in
            switch currentAttachment(params.udid.uppercased()) {
            case .failure(let error): return .error(error)
            case .success(let attachment): return .encoding(attachment.stats())
            }
        }
    }

    struct StartStreamParams: Decodable {
        let udid: String
        let service: String
        let token: UInt32
        let nonce: String
    }

    static let nonceRule = "nonce must be 16 lowercase hex digits, not all zero"

    func startStream(_ params: Data) -> Reply {
        decode(StartStreamParams.self, params) { params in
            if let refusal = refusal(for: startupReport.capabilities.display, .display) { return .error(refusal) }
            guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
            let range = NSRange(params.service.startIndex..., in: params.service)
            guard Self.rendezvousPattern.firstMatch(in: params.service, range: range) != nil else {
                return .error(HelperError(.badParams, "service is not a simulator rendezvous name (codes.pod.native[.dev].sim.<32 hex>)"))
            }
            guard FrameStream.tokenRange.contains(params.token) else {
                return .error(HelperError(.badParams, "token must be 1 to \(FrameStream.tokenRange.upperBound)"))
            }
            guard let nonce = FrameStream.nonce(params.nonce) else { return .error(HelperError(.badParams, Self.nonceRule)) }
            let udid = params.udid.uppercased()
            return deviceLocks.withLock(udid) {
                let attached = ensureAttached(udid)
                guard case .success(let (attachment, _)) = attached else {
                    if case .failure(let error) = attached { return .error(error) }
                    return .error(HelperError(.internal, "attach"))
                }
                switch FrameStream.open(service: params.service, token: params.token, nonce: nonce) {
                case .failure(let error):
                    if !attachment.isHeld { _ = displays.detach(udid, reason: nil) }
                    return .error(error)
                case .success(let stream):
                    let surface = attachment.addStream(stream)
                    return .encoding(StartStreamResult(
                        udid: udid, token: params.token, surface: surface.map(Self.describe), scale: attachment.scale))
                }
            }
        }
    }

    struct StopStreamParams: Decodable {
        let udid: String
        let token: UInt32
        /// Only this generation of the stream: a newer one under the same token stays.
        let nonce: String?
    }

    func stopStream(_ params: Data) -> Reply {
        decode(StopStreamParams.self, params) { params in
            let nonce = params.nonce.map(FrameStream.nonce)
            if case .some(nil) = nonce { return .error(HelperError(.badParams, Self.nonceRule)) }
            let udid = params.udid.uppercased()
            return deviceLocks.withLock(udid) {
                guard let attachment = displays.attachment(udid),
                      let stats = attachment.removeStream(token: params.token, nonce: nonce ?? nil)
                else {
                    let which = params.nonce.map { " with nonce \($0)" } ?? ""
                    return .error(HelperError(.notAttached, "no stream \(params.token)\(which) for \(params.udid)"))
                }
                if !attachment.isHeld { _ = displays.detach(udid, reason: nil) }
                return .encoding(stats)
            }
        }
    }

    /// A stream that ended on its own: the runtime hears of it, and a display its viewer was the last
    /// hold of detaches (an animating device otherwise costs a frame callback per frame with nobody
    /// watching). Off the attachment's queue: CoreSimulator waits on the callback, and a detach
    /// drains that queue.
    func streamEnded(_ event: StreamEndedEvent) {
        streamEnds.async { [weak self] in
            guard let self else { return }
            events.emit("streamEnded", event)
            guard event.reason == .viewerGone else { return }
            deviceLocks.withLock(event.udid) {
                if let attachment = displays.attachment(event.udid), !attachment.isHeld {
                    _ = displays.detach(event.udid, reason: nil)
                }
            }
        }
    }

    // MARK: - plumbing

    /// The device's attachment, made or replaced when it no longer shows this boot's framebuffer.
    /// Call under `deviceLocks`.
    func ensureAttached(_ udid: String) -> Result<(DisplayAttachment, Bool), HelperError> {
        // A device that shut down left an attachment on a framebuffer that is gone, this one too.
        displays.drop(where: { !self.isBooted($0) }, reason: .deviceShutDown)
        return booted(udid).flatMap { device in
            DisplayPort.main(of: device).flatMap { fresh in
                portLock.withLock { ports[udid] = fresh }
                return displays.attach(udid, isCurrent: { existing in
                    guard let stale = existing.staleness(against: fresh) else { return true }
                    HelperLog.note("attach \(udid): replacing the attachment: \(stale)")
                    return false
                }, make: {
                    DisplayAttachment(
                        port: fresh, scale: DeviceScreen.of(device).scale, bootedAt: device.lastBootedAt,
                        onStreamEnded: { [weak self] in self?.streamEnded($0) })
                }, replacing: { old, new in new.adopt(from: old) }).map { ($0.0, $0.alreadyAttached) }
            }
        }
    }

    /// The attachment while it still shows this boot's framebuffer; one whose device shut down or
    /// rebooted is dropped. Local calls only: the device's state and `lastBootedAt`.
    func currentAttachment(_ udid: String) -> Result<DisplayAttachment, HelperError> {
        guard let attachment = displays.attachment(udid) else {
            return .failure(HelperError(.notAttached, "no display attached for \(udid)"))
        }
        switch booted(udid) {
        case .failure(let error):
            displays.drop(udid, attachment, reason: .deviceShutDown)
            return .failure(HelperError(error.code, "\(error.message); its attachment ended"))
        case .success(let device):
            if let bootedAt = attachment.bootedAt, let now = device.lastBootedAt, now != bootedAt {
                displays.drop(udid, attachment, reason: .deviceRebooted)
                return .failure(HelperError(.notAttached, "\(udid) rebooted since it was attached; attach again"))
            }
            return .success(attachment)
        }
    }

    static func describe(_ surface: IOSurfaceRef) -> AttachDisplayResult.Surface {
        AttachDisplayResult.Surface(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), id: IOSurfaceGetID(surface))
    }
}
