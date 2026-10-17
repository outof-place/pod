import CoreGraphics
import Foundation
import Testing
import XPC
@testable import PodSimKit

/// A device's tree as fake lanes answer it: elements by name, each answered after its own delay.
final class FakeAXDevice: @unchecked Sendable {
    final class Element: NSObject, @unchecked Sendable {
        let name: String
        init(_ name: String) { self.name = name }
    }

    static let childrenKey = 8
    private(set) var elements: [String: Element] = [:]
    private var children: [String: [String]] = [:]
    var delayMs: [String: Int] = [:]
    var unanswered: Set<String> = []
    var silent = false

    private let lock = NSLock()
    private var underWay = 0
    private var busyLanes: Set<Int> = []
    private(set) var widest = 0
    private(set) var twoOnOneLane = false
    private(set) var asked: [String] = []

    init(_ shape: [String: [String]], root: String = "app") {
        children = shape
        for name in Set(shape.keys).union(shape.values.flatMap { $0 }).union([root]) { elements[name] = Element(name) }
    }

    var root: Element { elements["app"]! }

    func lanes(_ count: Int) -> [AXLane] { (0..<count).map { FakeLane(device: self, id: $0) } }

    fileprivate func answer(_ element: NSObject, lane: Int, done: @escaping @Sendable (AXValues?) -> Void) {
        let name = (element as? Element)?.name ?? "?"
        lock.withLock {
            if busyLanes.contains(lane) { twoOnOneLane = true }
            busyLanes.insert(lane)
            underWay += 1
            widest = max(widest, underWay)
            asked.append(name)
        }
        if silent { return }
        let values: AXValues? = unanswered.contains(name)
            ? nil
            : [Self.childrenKey: (children[name] ?? []).map { elements[$0]! }, 45: name]
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delayMs[name] ?? 1)) {
            self.lock.withLock {
                self.busyLanes.remove(lane)
                self.underWay -= 1
            }
            done(values)
        }
    }
}

private final class FakeLane: AXLane, @unchecked Sendable {
    let device: FakeAXDevice
    let id: Int

    init(device: FakeAXDevice, id: Int) {
        self.device = device
        self.id = id
    }

    func attributes(of element: NSObject, done: @escaping @Sendable (AXValues?) -> Void) {
        device.answer(element, lane: id, done: done)
    }

    func hitTest(_ point: CGPoint, done: @escaping @Sendable (AXHit?) -> Void) {
        // Answers x as the object id, later for lower y, and none for a negative x.
        let hit = point.x < 0 ? nil : AXHit(objectID: UInt64(point.x), pid: 1)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(20 - min(point.y, 19)))) { done(hit) }
    }
}

@Suite("Accessibility parallel read")
struct AXParallelReadTests {
    static func names(_ reads: [AXParallelWalk.Read]) -> [String] { reads.map { ($0.element as? FakeAXDevice.Element)?.name ?? "?" } }

    static func children(_ values: AXValues) -> [NSObject] { values[FakeAXDevice.childrenKey] as? [NSObject] ?? [] }

    @Test("elements come back in the translator walk's order (depth first, children as listed), whatever order the answers arrive in")
    func depthFirstOrder() throws {
        let device = FakeAXDevice(["app": ["a", "b", "c"], "a": ["a1", "a2"], "b": ["b1"]])
        device.delayMs = ["a": 40, "a1": 30, "b": 1, "b1": 1, "c": 1]
        let reads = try AXParallelWalk.run(
            root: device.root, lanes: device.lanes(4), limits: .init(deadline: .now() + 5), children: Self.children).get()
        #expect(Self.names(reads) == ["app", "a", "a1", "a2", "b", "b1", "c"])
        #expect(reads.map(\.parent) == [-1, 0, 1, 1, 0, 4, 0])
        #expect(reads.map(\.depth) == [0, 1, 2, 2, 1, 2, 1])
    }

    @Test("requests go out on every lane at once, and never two at a time on one lane")
    func lanesAtOnce() throws {
        let device = FakeAXDevice(["app": (0..<24).map { "row\($0)" }])
        for index in 0..<24 { device.delayMs["row\(index)"] = 15 }
        let reads = try AXParallelWalk.run(
            root: device.root, lanes: device.lanes(6), limits: .init(deadline: .now() + 10), children: Self.children).get()
        #expect(reads.count == 25)
        #expect(device.widest == 6)
        #expect(!device.twoOnOneLane)
    }

    @Test("the caps hold: nothing deeper than maxDepth, never more than maxElements, the shallower kept first")
    func caps() throws {
        let chain = FakeAXDevice(["app": ["d1"], "d1": ["d2"], "d2": ["d3"], "d3": ["d4"], "d4": ["d5"]])
        let deep = try AXParallelWalk.run(
            root: chain.root, lanes: chain.lanes(2), limits: .init(maxDepth: 3, deadline: .now() + 5), children: Self.children).get()
        #expect(Self.names(deep) == ["app", "d1", "d2", "d3"])
        #expect(!chain.asked.contains("d4"))

        let wide = FakeAXDevice(["app": ["a", "b"], "a": (0..<20).map { "a\($0)" }, "b": (0..<20).map { "b\($0)" }])
        let capped = try AXParallelWalk.run(
            root: wide.root, lanes: wide.lanes(4), limits: .init(maxElements: 10, deadline: .now() + 5), children: Self.children).get()
        #expect(capped.count == 10)
        #expect(Set(Self.names(capped)).isSuperset(of: ["app", "a", "b"]))
        #expect(wide.asked.count == 10)
    }

    @Test("an element the device did not answer is listed without values, and its children are never asked for")
    func unansweredElement() throws {
        let device = FakeAXDevice(["app": ["a", "b"], "b": ["b1"]])
        device.unanswered = ["b"]
        let reads = try AXParallelWalk.run(
            root: device.root, lanes: device.lanes(2), limits: .init(deadline: .now() + 5), children: Self.children).get()
        #expect(Self.names(reads) == ["app", "a", "b"])
        #expect(reads[2].values == nil)
        #expect(!device.asked.contains("b1"))
    }

    @Test("a read still waiting at its budget fails and says how far it got")
    func budget() {
        let device = FakeAXDevice(["app": ["a"]])
        device.silent = true
        let started = DispatchTime.now()
        let result = AXParallelWalk.run(
            root: device.root, lanes: device.lanes(2), limits: .init(deadline: .now() + .milliseconds(100)), children: Self.children)
        guard case .failure(let error) = result else { Issue.record("a silent device answered"); return }
        #expect(error.message == "the accessibility walk passed its time budget after 0 elements")
        #expect(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds < 2_000_000_000)
    }

    @Test("hit tests answer in the order of their points, an unanswered one as nil")
    func hitTestOrder() {
        let lanes = FakeAXDevice(["app": []]).lanes(3)
        let points = [CGPoint(x: 7, y: 0), CGPoint(x: -1, y: 5), CGPoint(x: 9, y: 19), CGPoint(x: 4, y: 10)]
        let hits = AXParallelWalk.hitTests(points, lanes: lanes, deadline: .now() + 5)
        #expect(hits == [AXHit(objectID: 7, pid: 1), nil, AXHit(objectID: 9, pid: 1), AXHit(objectID: 4, pid: 1)])
    }
}

@Suite("Accessibility covering")
struct AXCoveringTests {
    // app(1) -> card(2) -> title(3); app -> tabBar(4) -> tab(5); all in pid 10.
    let ids: [UInt64?] = [1, 2, 3, 4, 5]
    let parents = [-1, 0, 1, 0, 3]
    let pids: [Int32?] = [10, 10, 10, 10, 10]

    func lands(_ id: UInt64?, pid: Int32? = 10, on index: Int) -> Bool? {
        AXCovering.lands(
            AXHit(objectID: id, pid: pid), element: index, families: AXCovering.families(objectIDs: ids, parents: parents), pids: pids, root: 1)
    }

    @Test("a hit on the element, its descendant or its ancestor finds it")
    func ownFamily() {
        #expect(lands(2, on: 1) == true)
        #expect(lands(3, on: 1) == true)
        #expect(lands(2, on: 2) == true)
    }

    @Test("a hit on another element of the app means covered (the card under the tab bar)")
    func covered() {
        #expect(lands(5, on: 1) == false)
        #expect(lands(4, on: 2) == false)
    }

    @Test("the application element, another process's content or no id cannot tell")
    func cannotTell() {
        #expect(lands(1, on: 1) == nil)
        #expect(lands(99, pid: 20, on: 1) == nil)
        #expect(lands(nil, on: 1) == nil)
    }
}

@Suite("Accessibility tree cache")
struct AXTreeCacheTests {
    let device = NSObject()

    func tree(on device: NSObject? = nil) -> AXTreeRead {
        AXTreeRead(elements: [], parents: [], objectIDs: [], pids: [], appPid: 1, device: device ?? self.device)
    }

    func listening() -> AXTreeCache {
        var cache = AXTreeCache()
        cache.listen()
        return cache
    }

    @Test("a kept tree answers while the stamp holds: no notification, no input, same surface at the same seed")
    func holds() {
        var cache = listening()
        let stamp = cache.stamp(surface: (id: 3, seed: 41))
        cache.keep(tree(), stamp: stamp)
        #expect(cache.cached(at: cache.stamp(surface: (id: 3, seed: 41)), device: device) != nil)
    }

    @Test("a notification or input after the stamp, a new seed or a new surface each end the kept tree")
    func anyChangeEndsIt() {
        var cache = listening()
        let stamp = cache.stamp(surface: (id: 3, seed: 41))
        cache.keep(tree(), stamp: stamp)
        #expect(cache.cached(at: cache.stamp(surface: (id: 3, seed: 42)), device: device) == nil)
        #expect(cache.cached(at: cache.stamp(surface: (id: 4, seed: 41)), device: device) == nil)
        cache.changed()
        #expect(cache.cached(at: cache.stamp(surface: (id: 3, seed: 41)), device: device) == nil)
    }

    @Test("a change while the tree was being read leaves it unused: the stamp was taken before the read")
    func changeDuringRead() {
        var cache = listening()
        let before = cache.stamp(surface: (id: 3, seed: 41))
        cache.changed()
        cache.keep(tree(), stamp: before)
        #expect(cache.cached(at: cache.stamp(surface: (id: 3, seed: 41)), device: device) == nil)
    }

    @Test("nothing is kept without notifications or without a framebuffer to read")
    func needsBoth() {
        var deaf = AXTreeCache()
        #expect(deaf.stamp(surface: (id: 3, seed: 41)) == nil)
        deaf.keep(tree(), stamp: AXScreenStamp(changes: 0, surface: 3, seed: 41))
        #expect(deaf.cached(at: AXScreenStamp(changes: 0, surface: 3, seed: 41), device: device) == nil)
        #expect(listening().stamp(surface: nil) == nil)
    }

    @Test("notifications that stop drop the kept tree, even when they come back")
    func stopsListening() {
        var cache = listening()
        cache.keep(tree(), stamp: cache.stamp(surface: (id: 3, seed: 41)))
        cache.deaf()
        cache.listen()
        #expect(cache.cached(at: cache.stamp(surface: (id: 3, seed: 41)), device: device) == nil)
    }

    @Test("a rebooted device (a new device object) never gets the old boot's tree")
    func reboot() {
        var cache = listening()
        let stamp = cache.stamp(surface: (id: 3, seed: 41))
        cache.keep(tree(), stamp: stamp)
        #expect(cache.cached(at: stamp, device: NSObject()) == nil)
    }

    @Test("hit answers join the kept tree only when tested under its stamp")
    func hitsJoinTheirTree() throws {
        var cache = listening()
        let stamp = cache.stamp(surface: (id: 3, seed: 41))
        cache.keep(tree(), stamp: stamp)
        let cannotTell: Bool? = nil
        cache.addHits([2: false, 5: cannotTell], stamp: stamp)
        cache.addHits([7: true], stamp: AXScreenStamp(changes: 0, surface: 3, seed: 40))
        let hits = try #require(cache.cached(at: stamp, device: device)?.hits)
        #expect(hits.count == 2)
        #expect(hits[2] == .some(false))
        // Tested and "cannot tell": kept as an answer, so it is not asked again.
        #expect(hits.keys.contains(5) && hits[5]! == nil)
    }
}

@Suite("Accessibility device sessions")
struct AXDeviceSessionsTests {
    struct NoConnections: AXBridgeConnector {
        func connect(queue: DispatchQueue, onEvent: @escaping @Sendable (xpc_object_t) -> Void) -> AXBridgeLane? { nil }
    }

    final class Lookups: @unchecked Sendable {
        var count = 0
        func lookup() -> Result<AXBridgeConnector, HelperError> {
            count += 1
            return .success(NoConnections())
        }
    }

    @Test("a session unused for its idle time is closed by the timer, unasked")
    func idleTimer() throws {
        let sessions = AXDeviceSessions(idleSeconds: 0.05)
        let lookups = Lookups()
        _ = try sessions.session(udid: "A", device: NSObject(), boot: nil, lookup: lookups.lookup, listen: { _ in }).get()
        #expect(sessions.count == 1)
        Thread.sleep(forTimeInterval: 0.5)
        #expect(sessions.count == 0)
    }

    @Test("only sessions past their idle time close; one in use stays")
    func idleOnly() throws {
        let sessions = AXDeviceSessions(idleSeconds: 100)
        let lookups = Lookups()
        _ = try sessions.session(udid: "A", device: NSObject(), boot: nil, lookup: lookups.lookup, listen: { _ in }).get()
        sessions.closeIdle(now: .now() + 50)
        #expect(sessions.count == 1)
        sessions.closeIdle(now: .now() + 101)
        #expect(sessions.count == 0)
    }

    @Test("the same boot reuses its session without a lookup; a reboot (same device object, new boot time) gets a new one")
    func reuseAndReboot() throws {
        let sessions = AXDeviceSessions(idleSeconds: 100)
        let lookups = Lookups()
        let device = NSObject()
        let booted = Date(timeIntervalSince1970: 1_000)
        let first = try sessions.session(udid: "A", device: device, boot: booted, lookup: lookups.lookup, listen: { _ in }).get()
        let again = try sessions.session(udid: "A", device: device, boot: booted, lookup: lookups.lookup, listen: { _ in }).get()
        #expect(first === again && lookups.count == 1)
        let rebooted = try sessions.session(
            udid: "A", device: device, boot: Date(timeIntervalSince1970: 2_000), lookup: lookups.lookup, listen: { _ in }).get()
        #expect(rebooted !== first && lookups.count == 2 && sessions.count == 1)
    }

    @Test("a discarded session is looked up again on the next snapshot; discarding a replaced one changes nothing")
    func discard() throws {
        let sessions = AXDeviceSessions(idleSeconds: 100)
        let lookups = Lookups()
        let device = NSObject()
        let first = try sessions.session(udid: "A", device: device, boot: nil, lookup: lookups.lookup, listen: { _ in }).get()
        sessions.discard(first)
        let second = try sessions.session(udid: "A", device: device, boot: nil, lookup: lookups.lookup, listen: { _ in }).get()
        #expect(second !== first && lookups.count == 2)
        sessions.discard(first)
        #expect(sessions.existing("A") === second)
    }

    @Test("a session that cannot connect keeps nothing and says why")
    func cannotListen() throws {
        let session = AXDeviceSession(udid: "A", device: NSObject(), boot: nil, endpoint: NoConnections())
        session.listen(vocabulary: .init(attributes: [8], children: 8), timeout: 0.1)
        #expect(!session.isListening)
        #expect(session.listenProblem == "no connection to com.apple.CoreSimulator.accessibility")
        #expect(session.stamp(surface: (id: 3, seed: 41)) == nil)
    }
}

/// An accessibility service in this process: an anonymous XPC listener answering every request
/// with a translator response whose result is a translation object numbered by the request (1, 2...),
/// unless told to stay silent or to answer late, and sending notifications on request.
final class FakeAccessibilityService: AXBridgeConnector, @unchecked Sendable {
    private let queue = DispatchQueue(label: "fake.ax.service")
    private let listener: xpc_connection_t
    private let lock = NSLock()
    private var peers: [xpc_connection_t] = []
    var silent = false
    /// Each request's reply delay in turn; then none.
    var replyDelaysMs: [Int] = []
    private(set) var requests = 0

    init() {
        listener = xpc_connection_create(nil, queue)
        xpc_connection_set_event_handler(listener) { [weak self] peer in
            guard let self, xpc_get_type(peer) == XPC_TYPE_CONNECTION else { return }
            self.lock.withLock { self.peers.append(peer) }
            xpc_connection_set_event_handler(peer) { [weak self] message in
                guard let self, xpc_get_type(message) == XPC_TYPE_DICTIONARY else { return }
                let (silent, delay, number) = self.lock.withLock { () -> (Bool, Int, Int) in
                    self.requests += 1
                    return (self.silent, self.replyDelaysMs.isEmpty ? 0 : self.replyDelaysMs.removeFirst(), self.requests)
                }
                guard !silent, let reply = xpc_dictionary_create_reply(message) else { return }
                self.queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { xpc_connection_send_message(peer, Self.answer(reply, number: number)) }
            }
            xpc_connection_resume(peer)
        }
        xpc_connection_resume(listener)
    }

    static var available: Bool { (try? AXTranslatorBridge.shared().get()) != nil }

    private static func answer(_ reply: xpc_object_t, number: Int) -> xpc_object_t {
        let response = (NSClassFromString("AXPTranslatorResponse") as? NSObject.Type)?
            .perform(NSSelectorFromString("emptyResponse"))?.takeUnretainedValue() as? NSObject
        let translation = AXBridgeRequests.newTranslation()
        translation.setValue(UInt64(number), forKey: "objectID")
        response?.setValue(translation, forKey: "resultData")
        let data = response.flatMap { try? NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true) } ?? Data()
        let payload = xpc_dictionary_create(nil, nil, 0)
        data.withUnsafeBytes { xpc_dictionary_set_data(payload, AXBridgeTransport.responseKey, $0.baseAddress!, $0.count) }
        xpc_dictionary_set_string(reply, AXBridgeTransport.payloadClassNameKey, "AXPTranslatorResponse")
        xpc_dictionary_set_value(reply, AXBridgeTransport.payloadKey, payload)
        return reply
    }

    func connect(queue: DispatchQueue, onEvent: @escaping @Sendable (xpc_object_t) -> Void) -> AXBridgeLane? {
        let connection = xpc_connection_create_from_endpoint(xpc_endpoint_create(listener))
        xpc_connection_set_target_queue(connection, queue)
        xpc_connection_set_event_handler(connection, onEvent)
        xpc_connection_resume(connection)
        return AXBridgeLane(connection: connection)
    }

    /// A notification to every connection that has asked something.
    func notify() {
        for peer in lock.withLock({ peers }) { xpc_connection_send_message(peer, xpc_dictionary_create(nil, nil, 0)) }
    }

    /// The service ends every connection, as a restarted CoreSimulatorBridge does.
    func dropConnections() {
        for peer in lock.withLock({ () -> [xpc_connection_t] in defer { peers = [] }; return peers }) { xpc_connection_cancel(peer) }
    }

    deinit { xpc_connection_cancel(listener) }
}

@Suite("Accessibility notifications and lanes over XPC", .enabled(if: FakeAccessibilityService.available))
struct AXBridgeXPCTests {
    let vocabulary = AXBridgeRequests.Vocabulary(attributes: [8], children: 8)

    func eventually(_ seconds: Double = 3, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > end { return false }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return true
    }

    func tree() -> AXTreeRead { AXTreeRead(elements: [], parents: [], objectIDs: [], pids: [], appPid: 1, device: NSObject()) }

    @Test("listening starts without waiting, once the first request is answered; a notification then ends the kept tree")
    func listensAndHears() throws {
        let service = FakeAccessibilityService()
        let device = NSObject()
        let session = AXDeviceSession(udid: "A", device: device, boot: nil, endpoint: service)
        service.replyDelaysMs = [200]
        let started = Date()
        session.listen(vocabulary: vocabulary, timeout: 2)
        #expect(Date().timeIntervalSince(started) < 0.15)
        #expect(eventually { session.isListening })
        let stamp = session.stamp(surface: (id: 1, seed: 1))
        session.keep(AXTreeRead(elements: [], parents: [], objectIDs: [], pids: [], appPid: 1, device: device), stamp: stamp)
        #expect(session.cached(at: session.stamp(surface: (id: 1, seed: 1))) != nil)
        service.notify()
        #expect(eventually { session.cached(at: session.stamp(surface: (id: 1, seed: 1))) == nil })
    }

    @Test("the service ending the listening connection makes the session deaf and says so; it listens again later")
    func connectionEnds() throws {
        let service = FakeAccessibilityService()
        let session = AXDeviceSession(udid: "A", device: NSObject(), boot: nil, endpoint: service, listenRetrySeconds: 0)
        session.listen(vocabulary: vocabulary, timeout: 2)
        #expect(eventually { session.isListening })
        service.dropConnections()
        #expect(eventually { !session.isListening })
        #expect(session.listenProblem == "the notification connection ended")
        session.listen(vocabulary: vocabulary, timeout: 2)
        #expect(eventually { session.isListening })
    }

    @Test("a service that does not answer the first request: the session does not listen and says why")
    func silentService() {
        let service = FakeAccessibilityService()
        service.silent = true
        let session = AXDeviceSession(udid: "A", device: NSObject(), boot: nil, endpoint: service)
        session.listen(vocabulary: vocabulary, timeout: 0.1)
        #expect(eventually { session.listenProblem == "the notification connection's first request went unanswered" })
        #expect(!session.isListening)
    }

    @Test("a lane answers each request once: nil at its timeout, and a reply that comes later is dropped, not given to the next request")
    func laneTimeout() throws {
        let service = FakeAccessibilityService()
        // The first reply lands while the second request waits for its own.
        service.replyDelaysMs = [300, 600]
        let made = service.connect(queue: DispatchQueue(label: "lane.events"), onEvent: { _ in })
        let lane = try #require(made)
        defer { lane.cancel() }
        final class Answers: @unchecked Sendable {
            let lock = NSLock()
            var got: [String] = []
            func add(_ value: String) { lock.withLock { got.append(value) } }
            var all: [String] { lock.withLock { got } }
        }
        let answers = Answers()
        @Sendable func number(_ response: NSObject?) -> String {
            AXBridgeRequests.translation(response).flatMap { AXTreeReader.number($0, "objectID") }.map { "reply \($0)" } ?? "nil"
        }
        let request = try #require(AXBridgeRequests.frontmost())
        lane.send(request, timeout: 0.1) { answers.add("first: \(number($0))") }
        Thread.sleep(forTimeInterval: 0.2)
        lane.send(request, timeout: 2) { answers.add("second: \(number($0))") }
        #expect(eventually { answers.all.count == 2 })
        Thread.sleep(forTimeInterval: 0.7)
        #expect(answers.all == ["first: nil", "second: reply 2"])
    }
}
