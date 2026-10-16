import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

private final class FakeTransport: AXTransport, @unchecked Sendable {
    let kind = "bridge"
    let brokenReason: String? = nil
    private let lock = NSLock()
    private var wasClosed = false

    var closed: Bool { lock.withLock { wasClosed } }
    func send(_ request: AnyObject, timeout: TimeInterval) -> AnyObject? { nil }
    func close() { lock.withLock { wasClosed = true } }
}

private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [FakeTransport] = []
    func append(_ item: FakeTransport) { lock.withLock { items.append(item) } }
    var all: [FakeTransport] { lock.withLock { items } }
}

@Suite("Accessibility transports")
struct AXTransportsTests {
    @Test("two calls that race to connect one device both get the first stored transport; the other connection is closed")
    func raceClosesLoser() throws {
        let made = Collected()
        let bothConnecting = DispatchGroup()
        bothConnecting.enter()
        bothConnecting.enter()
        let transports = AXTransports { _ in
            let transport = FakeTransport()
            made.append(transport)
            bothConnecting.leave()
            bothConnecting.wait()
            return transport
        }
        let device = SimDeviceHandle(
            object: NSObject(), udid: "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", name: "iPhone 16 Pro", state: "Booted", screenPixels: .zero)
        let handed = Collected()
        let done = DispatchGroup()
        for _ in 0..<2 {
            DispatchQueue.global().async(group: done) {
                if let transport = transports.transport(for: device) as? FakeTransport { handed.append(transport) }
            }
        }
        #expect(done.wait(timeout: .now() + 5) == .success)
        let given = handed.all
        try #require(given.count == 2 && made.all.count == 2)
        #expect(given[0] === given[1])
        #expect(!given[0].closed)
        let loser = try #require(made.all.first { $0 !== given[0] })
        #expect(loser.closed)
        #expect(transports.transport(for: device) as? FakeTransport === given[0])
    }
}
