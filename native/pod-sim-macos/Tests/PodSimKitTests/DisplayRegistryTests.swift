import Foundation
import Testing
@testable import PodSimKit

/// A display whose start can be slow and whose stop is recorded.
private final class FakeDisplay: RegisteredDisplay, @unchecked Sendable {
    let udid: String
    let startDelay: useconds_t
    private let lock = NSLock()
    private var stoppedFlag = false

    init(_ udid: String, startDelay: useconds_t = 0) {
        self.udid = udid
        self.startDelay = startDelay
    }

    var stopped: Bool { lock.withLock { stoppedFlag } }

    func start() -> Result<Void, HelperError> {
        usleep(startDelay)
        return .success(())
    }

    func stats() -> DisplayStats {
        DisplayStats(udid: udid, seconds: 0, frameCallbacks: 0, surfaceCallbacks: 0, seedChanges: 0)
    }

    func stop() -> DisplayStats {
        lock.withLock { stoppedFlag = true }
        return stats()
    }
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
        let attaching = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = registry.attach("A", isCurrent: { _ in true }, make: { FakeDisplay("A", startDelay: 600_000) })
            attaching.signal()
        }
        usleep(50_000)
        let started = Date()
        let stats = registry.attachment("B")?.stats()
        let detached = registry.detach("B")
        #expect(Date().timeIntervalSince(started) < 0.2)
        #expect(stats?.udid == "B")
        #expect((try? detached.get())?.udid == "B")
        #expect(registry.attachment("A") == nil, "not attached until its start finished")
        attaching.wait()
        #expect(registry.attachment("A") != nil)
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
        registry.drop { $0 == "A" }
        #expect(registry.attachment("A") == nil)
        #expect(registry.attachment("B") === kept)
        #expect(eventually { gone.stopped })
        #expect(!kept.stopped)
    }

    @Test("a second attach of a device that is still attaching waits for it and gets the same attachment")
    func sameDeviceWaits() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        let first = FakeDisplay("A", startDelay: 300_000)
        DispatchQueue.global().async { _ = registry.attach("A", isCurrent: { _ in true }, make: { first }) }
        usleep(50_000)
        let second = try registry.attach("A", isCurrent: { _ in true }, make: { FakeDisplay("A") }).get()
        #expect(second.0 === first && second.alreadyAttached)
    }

    @Test("detach waits out an attach in progress instead of answering notAttached")
    func detachWaits() throws {
        let registry = DisplayRegistry<FakeDisplay>()
        DispatchQueue.global().async { _ = registry.attach("A", isCurrent: { _ in true }, make: { FakeDisplay("A", startDelay: 300_000) }) }
        usleep(50_000)
        #expect((try? registry.detach("A").get())?.udid == "A")
    }
}
