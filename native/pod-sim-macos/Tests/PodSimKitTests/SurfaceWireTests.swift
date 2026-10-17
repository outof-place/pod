import CPodSimSurface
import CoreGraphics
import Foundation
import ImageIO
import IOSurface
import Testing
@testable import PodSimKit

private func bgraSurface(width: Int, height: Int) -> IOSurfaceRef {
    makeSurface(width: width, height: height, bytesPerElement: 4, format: 0x4247_5241) // 'BGRA'
}

func makeSurface(width: Int, height: Int, bytesPerElement: Int, format: OSType) -> IOSurfaceRef {
    let properties: [CFString: Any] = [
        kIOSurfaceWidth: width, kIOSurfaceHeight: height, kIOSurfaceBytesPerElement: bytesPerElement,
        kIOSurfacePixelFormat: format,
    ]
    return IOSurfaceCreate(properties as CFDictionary)!
}

private func randomPixels(width: Int, height: Int, stride: Int, seed: UInt64) -> [UInt8] {
    var state = seed
    return (0..<(stride * height)).map { _ in
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return UInt8(truncatingIfNeeded: state >> 56)
    }
}

@Suite("Tile hashes")
struct TileHashTests {
    private func hashes(_ pixels: [UInt8], width: Int, height: Int, stride: Int) -> [UInt64] {
        var out = [UInt64](repeating: 0, count: ((width + 15) / 16) * ((height + 15) / 16))
        pixels.withUnsafeBufferPointer { pod_sim_tile_hashes_buffer($0.baseAddress, width, height, stride, 16, &out) }
        return out
    }

    @Test("a change marks exactly its tile: one high bit, two swapped words, two swapped rows")
    func localChanges() {
        let (width, height, stride) = (40, 40, 176)
        let base = randomPixels(width: width, height: height, stride: stride, seed: 7)
        let before = hashes(base, width: width, height: height, stride: stride)
        #expect(Set(before).count == before.count, "tiles of noise hash apart")

        func changedTiles(_ edit: (inout [UInt8]) -> Void) -> [Int] {
            var pixels = base
            edit(&pixels)
            let after = hashes(pixels, width: width, height: height, stride: stride)
            return before.indices.filter { before[$0] != after[$0] }
        }
        // Pixel (20, 37) is in tile (1, 2), index 1 + 2 * 3.
        #expect(changedTiles { $0[37 * stride + 20 * 4 + 2] ^= 0x80 } == [7])
        // Bytes 0..7 and 8..15 of row 3: pixels 0 to 3, tile 0.
        #expect(changedTiles { p in for i in 0..<8 { p.swapAt(3 * stride + i, 3 * stride + 8 + i) } } == [0])
        #expect(changedTiles { p in for i in 0..<64 { p.swapAt(17 * stride + 64 + i, 18 * stride + 64 + i) } } == [4])
        // Padding past the width is never read.
        #expect(changedTiles { $0[5 * stride + width * 4 + 1] ^= 0xFF } == [])
    }

    @Test("the surface read matches the buffer read and reports the seeds around it")
    func surfaceRead() throws {
        let surface = bgraSurface(width: 50, height: 20)
        IOSurfaceLock(surface, [], nil)
        let stride = IOSurfaceGetBytesPerRow(surface)
        let pixels = randomPixels(width: 50, height: 20, stride: stride, seed: 3)
        pixels.withUnsafeBytes { _ = memcpy(IOSurfaceGetBaseAddress(surface), $0.baseAddress, pixels.count) }
        IOSurfaceUnlock(surface, [], nil)
        var fromSurface = [UInt64](repeating: 0, count: 8)
        var before: UInt32 = 0, after: UInt32 = 0
        #expect(pod_sim_tile_hashes(Unmanaged.passUnretained(surface).toOpaque(), 16, &fromSurface, 8, &before, &after) == 0)
        #expect(fromSurface == hashes(pixels, width: 50, height: 20, stride: stride))
        #expect(before == after && after == IOSurfaceGetSeed(surface))
        #expect(pod_sim_tile_hashes(Unmanaged.passUnretained(surface).toOpaque(), 16, &fromSurface, 7, nil, nil) == -1)
    }
}

@Suite("PNG encoder")
struct PNGEncoderTests {
    /// Decodes into sRGB RGBA8, the space the PNG is tagged with, so nothing is colour-converted.
    private func decode(_ data: Data) throws -> (width: Int, height: Int, rgba: [UInt8]) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let drawn = rgba.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(
                data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        #expect(drawn)
        return (image.width, image.height, rgba)
    }

    @Test("every pixel survives, across strip edges and odd sizes", arguments: [(37, 23), (7, 100), (1, 1), (300, 17)])
    func lossless(_ size: (Int, Int)) throws {
        let (width, height) = size
        let stride = width * 4 + 12
        let bgra = randomPixels(width: width, height: height, stride: stride, seed: UInt64(width * 1_000 + height))
        var out: UnsafeMutablePointer<UInt8>?
        var count = 0
        #expect(bgra.withUnsafeBufferPointer { pod_sim_png_encode($0.baseAddress, width, height, stride, &out, &count) } == 0)
        let png = Data(bytes: try #require(out), count: count)
        free(out)
        #expect(png.prefix(8) == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
        #expect(png.range(of: Data("sRGB".utf8)) != nil)
        let decoded = try decode(png)
        #expect(decoded.width == width && decoded.height == height)
        var differing = 0
        for y in 0..<height {
            for x in 0..<width {
                let source = y * stride + x * 4, target = (y * width + x) * 4
                if decoded.rgba[target] != bgra[source + 2] || decoded.rgba[target + 1] != bgra[source + 1]
                    || decoded.rgba[target + 2] != bgra[source] || decoded.rgba[target + 3] != 255 { differing += 1 }
            }
        }
        #expect(differing == 0)
    }
}

/// What the reference receiver handed over, and a gate that can hold its thread (a stuck viewer).
private final class Viewer: @unchecked Sendable {
    struct Message: Equatable {
        let kind: UInt32, token: UInt32, seq: UInt64, surfaceID: UInt32, width: UInt32, height: UInt32, scale: UInt32, seed: UInt32
        let damage: [Int32]
        let nonce: UInt64
        let pid: pid_t
    }

    /// What pod-sim's release build must meet; this test process does not.
    static let helperRequirement = #"anchor apple generic and certificate leaf[subject.OU] = "75Y2KR6P5W" and identifier "codes.pod.sim""#

    let name = "codes.pod.native.dev.sim." + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private(set) var receiver: OpaquePointer?
    private let lock = NSLock()
    private var received: [Message] = []
    private var holding = false
    private let gate = DispatchSemaphore(value: 0)

    var messages: [Message] { lock.withLock { received } }
    var counts: pod_sim_receiver_counts { pod_sim_receiver_get_counts(receiver) }

    func hold() { lock.withLock { holding = true } }

    func release() {
        lock.withLock { holding = false }
        gate.signal()
    }

    func take(_ info: pod_sim_frame_info) {
        let hold = lock.withLock { () -> Bool in
            received.append(Message(
                kind: info.kind, token: info.token, seq: info.seq, surfaceID: info.surface_id, width: info.width, height: info.height,
                scale: info.scale_x100, seed: info.seed, damage: [info.damage_x, info.damage_y, info.damage_width, info.damage_height],
                nonce: info.nonce, pid: info.sender_pid))
            return holding
        }
        if hold { gate.wait() }
    }

    func wait(count: Int, seconds: Double = 2) -> [Message] {
        let end = Date().addingTimeInterval(seconds)
        while messages.count < count, Date() < end { usleep(2_000) }
        return messages
    }

    func waitCounts(seconds: Double = 2, until done: (pod_sim_receiver_counts) -> Bool) -> pod_sim_receiver_counts {
        let end = Date().addingTimeInterval(seconds)
        while !done(counts), Date() < end { usleep(2_000) }
        return counts
    }

    /// Checks a fresh rendezvous name in, keeping only `nonce`'s stream, admitting this process or,
    /// with `requirement`, only senders meeting it.
    static func start(expecting nonce: UInt64, requirement: String? = nil) throws -> Viewer {
        let viewer = Viewer()
        var error: Int32 = 0
        viewer.receiver = try #require(pod_sim_receiver_start(viewer.name, { context, surface, info in
            let viewer = Unmanaged<Viewer>.fromOpaque(context!).takeUnretainedValue()
            if let surface { Unmanaged<IOSurfaceRef>.fromOpaque(surface).release() }
            viewer.take(info!.pointee)
        }, Unmanaged.passUnretained(viewer).toOpaque(), &error), "check-in failed: \(error)")
        if let requirement { pod_sim_receiver_admit(viewer.receiver, requirement) } else { pod_sim_receiver_admit_self(viewer.receiver) }
        pod_sim_receiver_expect(viewer.receiver, nonce)
        return viewer
    }

    /// Ends the receiver; held messages are let go first.
    func stop() {
        release()
        pod_sim_receiver_stop(receiver)
        receiver = nil
    }

    /// A send right to this viewer's port, looked up by name as a sender does. In this process it is
    /// the receive right's own name.
    func lookUp() throws -> mach_port_t {
        typealias LookUp = @convention(c) (mach_port_t, UnsafePointer<CChar>, UnsafeMutablePointer<mach_port_t>) -> kern_return_t
        let symbol = try #require(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "bootstrap_look_up"))
        var bootstrap: mach_port_t = 0
        try #require(task_get_special_port(mach_task_self_, TASK_BOOTSTRAP_PORT, &bootstrap) == KERN_SUCCESS)
        defer { mach_port_deallocate(mach_task_self_, bootstrap) }
        var port: mach_port_t = 0
        #expect(unsafeBitCast(symbol, to: LookUp.self)(bootstrap, name, &port) == KERN_SUCCESS)
        return port
    }
}

private func sendRefs(_ port: mach_port_t) -> mach_port_urefs_t {
    var refs: mach_port_urefs_t = 0
    _ = mach_port_get_refs(mach_task_self_, port, MACH_PORT_RIGHT_SEND, &refs)
    return refs
}

/// A surface-shaped message to `port` carrying `descriptor` with `disposition`, and a send right made
/// from `reply` when given.
private func sendForeign(
    to port: mach_port_t, descriptor: mach_port_t, disposition: Int32, reply: mach_port_t = 0, nonce: UInt64
) -> kern_return_t {
    var msg = pod_sim_surface_msg_t()
    let local = reply == 0 ? 0 : mach_msg_bits_t(MACH_MSG_TYPE_MAKE_SEND) << 8
    msg.header.msgh_bits = mach_msg_bits_t(MACH_MSG_TYPE_COPY_SEND) | local | MACH_MSGH_BITS_COMPLEX
    msg.header.msgh_size = mach_msg_size_t(MemoryLayout<pod_sim_surface_msg_t>.size)
    msg.header.msgh_remote_port = port
    msg.header.msgh_local_port = reply
    msg.header.msgh_id = mach_msg_id_t(bitPattern: POD_SIM_SURFACE_MSG_ID)
    msg.body.msgh_descriptor_count = 1
    msg.surface.name = descriptor
    msg.surface.disposition = mach_msg_type_name_t(disposition)
    msg.surface.type = mach_msg_descriptor_type_t(MACH_MSG_PORT_DESCRIPTOR)
    msg.version = POD_SIM_WIRE_VERSION
    msg.token = 3
    msg.nonce = nonce
    return withUnsafeMutablePointer(to: &msg.header) {
        mach_msg($0, MACH_SEND_MSG | MACH_SEND_TIMEOUT, $0.pointee.msgh_size, 0, mach_port_t(MACH_PORT_NULL), 0, mach_port_t(MACH_PORT_NULL))
    }
}

@Suite("Frame stream")
struct FrameStreamTests {
    private let nonce: UInt64 = 0x9e37_79b9_7f4a_7c15

    @Test("the viewer gets the surface first, then one frame message per frame with its seed and nonce, from this process")
    func roundTrip() throws {
        let viewer = try Viewer.start(expecting: nonce)
        defer { viewer.stop() }
        let stream = try FrameStream.open(service: viewer.name, token: 1_953, nonce: nonce).get()
        let surface = bgraSurface(width: 64, height: 32)
        // Frames come 16 ms apart from a device; here each waits for the one before to arrive.
        for count in 2...4 {
            #expect(stream.sendFrame(surface: surface, seed: IOSurfaceGetSeed(surface), scaleX100: 300, advance: true) == .sent)
            _ = viewer.wait(count: count)
        }
        let got = viewer.messages
        let id = IOSurfaceGetID(surface)
        #expect(got.count == 4)
        #expect(got.first == Viewer.Message(
            kind: POD_SIM_SURFACE_MSG_ID, token: 1_953, seq: 1, surfaceID: id, width: 64, height: 32, scale: 300,
            seed: IOSurfaceGetSeed(surface), damage: [0, 0, 0, 0], nonce: nonce, pid: getpid()))
        #expect(got.dropFirst().map(\.kind) == Array(repeating: POD_SIM_FRAME_MSG_ID, count: 3))
        #expect(got.dropFirst().map(\.seq) == [1, 2, 3])
        #expect(got.dropFirst().allSatisfy { $0.surfaceID == id && $0.damage == [0, 0, 64, 32] && $0.token == 1_953 && $0.nonce == self.nonce })
        #expect(stream.stats() == StreamStats(token: 1_953, framesSent: 3, framesDropped: 0, surfaceSends: 1, seq: 3))
        #expect(viewer.counts.refused == 0 && viewer.counts.stale == 0)
    }

    @Test("a sender that does not meet the viewer's requirement is refused before anything is handed over")
    func refused() throws {
        let viewer = try Viewer.start(expecting: nonce, requirement: Viewer.helperRequirement)
        defer { viewer.stop() }
        let stream = try FrameStream.open(service: viewer.name, token: 5, nonce: nonce).get()
        #expect(stream.sendFrame(surface: bgraSurface(width: 8, height: 8), seed: 1, scaleX100: 200, advance: true) == .sent)
        #expect(viewer.waitCounts { $0.refused >= 2 }.refused == 2)
        #expect(viewer.messages.isEmpty)
    }

    @Test("an admitted sender with another nonce (a stream the viewer was not given) is dropped")
    func otherNonce() throws {
        let viewer = try Viewer.start(expecting: nonce)
        defer { viewer.stop() }
        let stream = try FrameStream.open(service: viewer.name, token: 5, nonce: nonce ^ 1).get()
        #expect(stream.sendFrame(surface: bgraSurface(width: 8, height: 8), seed: 1, scaleX100: 200, advance: true) == .sent)
        let counts = viewer.waitCounts { $0.stale >= 2 }
        #expect(counts.stale == 2 && counts.admitted == 0 && counts.refused == 0)
        #expect(viewer.messages.isEmpty)
    }

    @Test("a stuck viewer never blocks the helper: a full queue drops frames at once, counts them, and keeps no right")
    func stuckViewer() throws {
        let viewer = try Viewer.start(expecting: nonce)
        defer { viewer.stop() }
        viewer.hold()
        let stream = try FrameStream.open(service: viewer.name, token: 9, nonce: nonce).get()
        let port = try viewer.lookUp()
        defer { mach_port_deallocate(mach_task_self_, port) }
        let surface = bgraSurface(width: 8, height: 8)
        let surfacePort = IOSurfaceCreateMachPort(surface)
        defer { mach_port_deallocate(mach_task_self_, surfacePort) }
        let (portRefs, surfaceRefs) = (sendRefs(port), sendRefs(surfacePort))
        let started = Date()
        let sent = (0..<40).map { i -> FrameStream.Delivery in
            // Every fourth frame carries the surface again: dropped surface messages hold a framebuffer right.
            if i % 4 == 0 { stream.forgetSurface() }
            return stream.sendFrame(surface: surface, seed: 1, scaleX100: 200, advance: true)
        }
        #expect(Date().timeIntervalSince(started) < 0.2)
        #expect(sent.contains(.full))
        let stats = stream.stats()
        #expect(stats.framesDropped == sent.filter { $0 == .full }.count)
        #expect(stats.framesSent + stats.framesDropped == 40)
        #expect(stream.ended == nil)
        #expect(sendRefs(port) == portRefs, "each dropped message gave its right to the viewer's port back")
        #expect(sendRefs(surfacePort) == surfaceRefs, "each dropped surface message gave its framebuffer right back")
    }

    @Test("a message the viewer does not keep leaves no right behind: a refused one with a reply right, one moving a receive right")
    func foreignRightsDestroyed() throws {
        let viewer = try Viewer.start(expecting: nonce, requirement: Viewer.helperRequirement)
        defer { viewer.stop() }
        let port = try viewer.lookUp()
        let surfacePort = IOSurfaceCreateMachPort(bgraSurface(width: 8, height: 8))
        var reply: mach_port_t = 0
        #expect(mach_port_allocate(mach_task_self_, MACH_PORT_RIGHT_RECEIVE, &reply) == KERN_SUCCESS)
        defer {
            mach_port_deallocate(mach_task_self_, port)
            mach_port_deallocate(mach_task_self_, surfacePort)
            mach_port_mod_refs(mach_task_self_, reply, MACH_PORT_RIGHT_RECEIVE, -1)
        }
        // One at a time, each handled before the next: a full queue would bounce the message back.
        func handled(_ send: () -> kern_return_t) {
            let seen = viewer.counts.refused + viewer.counts.malformed
            #expect(send() == KERN_SUCCESS)
            let after = viewer.waitCounts { $0.refused + $0.malformed > seen }
            #expect(after.refused + after.malformed == seen + 1)
        }
        // A sender meeting the requirement would be admitted; this test process is refused.
        func refusedSurface() -> kern_return_t {
            sendForeign(to: port, descriptor: surfacePort, disposition: MACH_MSG_TYPE_COPY_SEND, reply: reply, nonce: nonce)
        }
        // The viewer is in this process: a receive right it kept would come back under the name a send
        // right of ours holds, which turns into a dead name once the viewer destroys it.
        func receiveRightKept() -> Bool {
            var right: mach_port_t = 0
            guard mach_port_allocate(mach_task_self_, MACH_PORT_RIGHT_RECEIVE, &right) == KERN_SUCCESS,
                  mach_port_insert_right(mach_task_self_, right, right, mach_msg_type_name_t(MACH_MSG_TYPE_MAKE_SEND)) == KERN_SUCCESS
            else { return true }
            handled { sendForeign(to: port, descriptor: right, disposition: MACH_MSG_TYPE_MOVE_RECEIVE, nonce: nonce) }
            var type: mach_port_type_t = 0
            _ = mach_port_type(mach_task_self_, right, &type)
            let kept = type & (mach_port_type_t(1) << (MACH_PORT_RIGHT_RECEIVE + 16)) != 0
            if kept { mach_port_mod_refs(mach_task_self_, right, MACH_PORT_RIGHT_RECEIVE, -1) }
            mach_port_deallocate(mach_task_self_, right)
            return kept
        }
        handled(refusedSurface)
        let surfaceRefs = sendRefs(surfacePort)
        let rounds = 32
        var kept = 0
        for _ in 0..<rounds {
            handled(refusedSurface)
            if receiveRightKept() { kept += 1 }
        }
        #expect(viewer.counts.admitted == 0 && viewer.messages.isEmpty)
        #expect(sendRefs(reply) == 0, "each refused message's reply right was destroyed")
        #expect(sendRefs(surfacePort) == surfaceRefs, "and its surface right")
        #expect(kept == 0, "each received receive right was destroyed")
    }

    @Test("a viewer whose port was destroyed stops receiving instead of spinning")
    func portDestroyed() throws {
        let viewer = try Viewer.start(expecting: nonce)
        let port = try viewer.lookUp()
        #expect(mach_port_mod_refs(mach_task_self_, port, MACH_PORT_RIGHT_RECEIVE, -1) == KERN_SUCCESS)
        usleep(200_000)
        #expect(viewer.counts.malformed <= 1, "the receive loop saw a dead port and ended")
        mach_port_deallocate(mach_task_self_, port)
    }

    @Test("stop ends the receive thread, and its name takes no stream")
    func stop() throws {
        let viewer = try Viewer.start(expecting: nonce)
        let name = viewer.name
        let stopped = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            viewer.stop()
            stopped.signal()
        }
        #expect(stopped.wait(timeout: .now() + 2) == .success)
        // launchd may still hand out the dead name for a moment; a send to it then ends the stream.
        if case .success(let stream) = FrameStream.open(service: name, token: 1, nonce: nonce) {
            #expect(stream.sendFrame(surface: bgraSurface(width: 8, height: 8), seed: 1, scaleX100: 100, advance: true) == .ended)
        }
    }

    @Test("no viewer under the name: the stream does not open")
    func noViewer() {
        let name = "codes.pod.native.dev.sim." + String(repeating: "0", count: 32)
        guard case .failure(let error) = FrameStream.open(service: name, token: 1, nonce: nonce) else {
            Issue.record("opened a stream nobody checked in")
            return
        }
        #expect(error.code == .failed)
    }

    @Test("a nonce is 16 lowercase hex digits and never zero")
    func nonceText() {
        #expect(FrameStream.nonce("9e3779b97f4a7c15") == 0x9e37_79b9_7f4a_7c15)
        #expect(FrameStream.nonceText(0x00ab) == "00000000000000ab")
        for bad in ["0000000000000000", "9E3779B97F4A7C15", "9e3779b97f4a7c1", "9e3779b97f4a7c150", "+e3779b97f4a7c15", "9e3779b97f4a7cxz"] {
            #expect(FrameStream.nonce(bad) == nil, "\(bad)")
        }
    }
}

/// A main display's descriptor as CoreSimulator hands it out: its framebuffer, and screen callbacks
/// on the queue given, which `present` runs the way a device presents a frame.
private final class FakeScreen: NSObject, @unchecked Sendable {
    let framebuffer: IOSurfaceRef
    private let lock = NSLock()
    private var frame: (() -> Void)?
    private var queue: DispatchQueue?

    init(_ framebuffer: IOSurfaceRef) { self.framebuffer = framebuffer }

    @objc func framebufferSurface() -> AnyObject { framebuffer }

    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func register(
        uuid: UUID, callbackQueue: DispatchQueue, frameCallback: @escaping () -> Void,
        surfacesChangedCallback: @escaping (Any?, Any?) -> Void, propertiesChangedCallback: @escaping (Any?) -> Void
    ) {
        lock.withLock {
            frame = frameCallback
            queue = callbackQueue
        }
    }

    @objc(unregisterScreenCallbacksWithUUID:)
    func unregister(uuid: UUID) { lock.withLock { frame = nil } }

    /// A new frame in the surface (its seed moves), then the frame callback, waited for.
    func present() {
        IOSurfaceLock(framebuffer, [], nil)
        IOSurfaceGetBaseAddress(framebuffer).storeBytes(of: UInt32.random(in: 0...UInt32.max), as: UInt32.self)
        IOSurfaceUnlock(framebuffer, [], nil)
        let (frame, queue) = lock.withLock { (frame, queue) }
        queue?.sync { frame?() }
    }
}

private final class EndedStreams: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [StreamEndedEvent] = []
    var all: [StreamEndedEvent] { lock.withLock { events } }
    func add(_ event: StreamEndedEvent) { lock.withLock { events.append(event) } }
}

@Suite("Display attachment streams")
struct AttachmentStreamTests {
    private let nonce: UInt64 = 0x0123_4567_89ab_cdef

    private func attached(_ ended: EndedStreams) throws -> (DisplayAttachment, FakeScreen) {
        let screen = FakeScreen(bgraSurface(width: 64, height: 32))
        let attachment = DisplayAttachment(
            port: DisplayPort(udid: "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", descriptor: screen, selection: "fake"),
            onStreamEnded: { ended.add($0) })
        try attachment.start().get()
        return (attachment, screen)
    }

    @Test("a viewer that is gone leaves at once: its stream is dropped, reported viewerGone, and no longer holds the display")
    func viewerGone() throws {
        let ended = EndedStreams()
        let (attachment, screen) = try attached(ended)
        defer { _ = attachment.stop(nil) }
        let viewer = try Viewer.start(expecting: nonce)
        _ = attachment.addStream(try FrameStream.open(service: viewer.name, token: 4, nonce: nonce).get())
        screen.present()
        #expect(viewer.wait(count: 2).map(\.kind) == [POD_SIM_SURFACE_MSG_ID, POD_SIM_FRAME_MSG_ID])
        #expect(attachment.isHeld)
        viewer.stop()
        screen.present()
        #expect(attachment.stats().streams == nil, "the ended stream is not listed")
        #expect(!attachment.isHeld, "nothing holds the display any more")
        #expect(ended.all == [StreamEndedEvent(
            udid: "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", token: 4, nonce: "0123456789abcdef", reason: .viewerGone)])
    }

    @Test("a stopped attachment reports each stream with the reason, and none when the helper exits")
    func stopReports() throws {
        let ended = EndedStreams()
        let (attachment, _) = try attached(ended)
        let viewers = try [Viewer.start(expecting: nonce), Viewer.start(expecting: nonce)]
        defer { viewers.forEach { $0.stop() } }
        for (token, viewer) in zip([9, 2] as [UInt32], viewers) {
            _ = attachment.addStream(try FrameStream.open(service: viewer.name, token: token, nonce: nonce).get())
        }
        _ = attachment.stop(.deviceRebooted)
        #expect(ended.all.map(\.token) == [2, 9])
        #expect(ended.all.allSatisfy { $0.reason == .deviceRebooted && $0.nonce == "0123456789abcdef" })

        let quiet = EndedStreams()
        let (other, _) = try attached(quiet)
        _ = other.addStream(try FrameStream.open(service: viewers[0].name, token: 1, nonce: nonce).get())
        _ = other.stop(nil)
        #expect(quiet.all.isEmpty)
    }

    @Test("stopStream with a nonce stops only that generation of a token")
    func stopByGeneration() throws {
        let (attachment, _) = try attached(EndedStreams())
        defer { _ = attachment.stop(nil) }
        let viewer = try Viewer.start(expecting: nonce)
        defer { viewer.stop() }
        _ = attachment.addStream(try FrameStream.open(service: viewer.name, token: 6, nonce: nonce).get())
        #expect(attachment.removeStream(token: 6, nonce: nonce ^ 1) == nil, "an older generation's stop leaves the newer one")
        #expect(attachment.removeStream(token: 6, nonce: nonce)?.token == 6)
    }
}

@Suite("Screenshot pixel format")
struct ScreenshotFormatTests {
    @Test("a framebuffer in a 4-byte format other than BGRA is refused with failed, the code that falls back to simctl")
    func otherFormat() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("pod-sim-format-\(UUID().uuidString).png").path
        let options = ImageOptions(format: .png, scale: 1, quality: 0.8)
        let rgba = makeSurface(width: 8, height: 8, bytesPerElement: 4, format: 0x5247_4241) // 'RGBA'
        guard case .failure(let error) = ImageWriter().write(surface: rgba, to: path, options) else {
            Issue.record("encoded RGBA as if it were BGRA")
            try? FileManager.default.removeItem(atPath: path)
            return
        }
        #expect(error.code == .failed)
        #expect(!FileManager.default.fileExists(atPath: path))
        let written = try ImageWriter().write(surface: bgraSurface(width: 8, height: 8), to: path, options).get()
        #expect(written.width == 8)
        try FileManager.default.removeItem(atPath: path)
    }
}
