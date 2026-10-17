import Foundation
import Testing
@testable import PodSimKit

/// A display whose start signals `began`, then waits for `gate` when it has one; its stop is recorded.
private final class FakeDisplay: RegisteredDisplay, @unchecked Sendable {
    let udid: String
    let began = DispatchSemaphore(value: 0)
    private let gate: DispatchSemaphore?
    private let lock = NSLock()
    private var stoppedFlag = false
    private var endReason: StreamEndReason?

    init(_ udid: String, gate: DispatchSemaphore? = nil) {
        self.udid = udid
        self.gate = gate
    }

    var stopped: Bool { lock.withLock { stoppedFlag } }
    var stoppedFor: StreamEndReason? { lock.withLock { endReason } }

    func start() -> Result<Void, HelperError> {
        began.signal()
        gate?.wait()
        return .success(())
    }

    func stats() -> DisplayStats {
        DisplayStats(udid: udid, seconds: 0, frameCallbacks: 0, surfaceCallbacks: 0, seedChanges: 0)
    }

    func stop(_ reason: StreamEndReason?) -> DisplayStats {
        lock.withLock {
            stoppedFlag = true
            endReason = reason
        }
        return stats()
    }

    /// Waits until a start began elsewhere; false after 5 s.
    func waitBegan() -> Bool { began.wait(timeout: .now() + 5) == .success }
}

private func eventually(_ check: () -> Bool, within seconds: Double = 2) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !check(), Date() < end { usleep(5_000) }
    return check()
}

@Suite("Display registry")
struct DisplayRegistryTests {
    @Test("one device's slow attach never holds up stats or detach of another")
    func slowAttachIsolated() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        _ = registry.attach("B", isCurrent: { _ in true }, make: { FakeDisplay("B") })
        let gate = DispatchSemaphore(value: 0)
        let slow = FakeDisplay("A", gate: gate)
        let attaching = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = registry.attach("A", isCurrent: { _ in true }, make: { slow })
            attaching.signal()
        }
        try #require(slow.waitBegan())
        let started = Date()
        let stats = registry.attachment("B")?.stats()
        let detached = registry.detach("B")
        // A's start stays blocked until the gate opens: waiting on it would take the 5 s wait limit.
        #expect(Date().timeIntervalSince(started) < 2)
        #expect(stats?.udid == "B")
        #expect((try? detached.get())?.udid == "B")
        #expect(registry.attachment("A") == nil, "not attached until its start finished")
        gate.signal()
        attaching.wait()
        #expect(registry.attachment("A") === slow)
    }

    @Test("an attachment that no longer shows the device's framebuffer is replaced; a current one is kept")
    func staleReplaced() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        let first = FakeDisplay("A")
        _ = registry.attach("A", isCurrent: { _ in true }, make: { first })

        let kept = try registry.attach("A", isCurrent: { _ in true }, make: { FakeDisplay("A") }).get()
        #expect(kept.0 === first && kept.alreadyAttached)

        let second = FakeDisplay("A")
        let replaced = try registry.attach("A", isCurrent: { $0 !== first }, make: { second }).get()
        #expect(replaced.0 === second && !replaced.alreadyAttached)
        #expect(registry.attachment("A") === second)
        #expect(eventually { first.stopped }, "the stale one's callbacks are removed")
    }

    @Test("attachments of devices no longer booted are dropped and stopped")
    func dropsGone() {
        let registry = DisplayRegistry<FakeDisplay>()
        let gone = FakeDisplay("A"), kept = FakeDisplay("B")
        _ = registry.attach("A", isCurrent: { _ in true }, make: { gone })
        _ = registry.attach("B", isCurrent: { _ in true }, make: { kept })
        registry.drop(where: { $0 == "A" }, reason: .deviceShutDown)
        #expect(registry.attachment("A") == nil)
        #expect(registry.attachment("B") === kept)
        #expect(eventually { gone.stopped })
        #expect(gone.stoppedFor == .deviceShutDown, "its streams end saying why")
        #expect(!kept.stopped)
    }

    @Test("a second attach of a device that is still attaching waits for it and gets the same attachment")
    func sameDeviceWaits() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        let gate = DispatchSemaphore(value: 0)
        let first = FakeDisplay("A", gate: gate)
        DispatchQueue.global().async { _ = registry.attach("A", isCurrent: { _ in true }, make: { first }) }
        try #require(first.waitBegan())
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { gate.signal() }
        let second = try registry.attach("A", isCurrent: { _ in true }, make: { FakeDisplay("A") }).get()
        #expect(second.0 === first && second.alreadyAttached)
    }

    @Test("detach waits out an attach in progress instead of answering notAttached")
    func detachWaits() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        let gate = DispatchSemaphore(value: 0)
        let slow = FakeDisplay("A", gate: gate)
        DispatchQueue.global().async { _ = registry.attach("A", isCurrent: { _ in true }, make: { slow }) }
        try #require(slow.waitBegan())
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { gate.signal() }
        #expect((try? registry.detach("A").get())?.udid == "A")
        #expect(slow.stoppedFor == .detached)
    }
}
