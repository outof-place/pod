import CoreGraphics
import Foundation

/// One element's attributes as the device answered them, keyed by AXP attribute number.
typealias AXValues = [Int: Any]

/// What a hit test found: the element's id and process, either unknown when the device did not say.
struct AXHit: Equatable, Sendable {
    let objectID: UInt64?
    let pid: Int32?
}

/// A connection to one device's accessibility service that carries one request at a time.
protocol AXLane: AnyObject, Sendable {
    /// The walk's attributes of one element (a translation object); nil when unanswered.
    func attributes(of element: NSObject, done: @escaping @Sendable (AXValues?) -> Void)
    func hitTest(_ point: CGPoint, done: @escaping @Sendable (AXHit?) -> Void)
}

/// Runs work across lanes, each lane carrying one piece at a time, first in first out. Work may add
/// more work before it reports done (a walk's children), so `wait` returns once nothing is queued
/// or under way.
final class AXLanePool: @unchecked Sendable {
    typealias Work = @Sendable (AXLane, _ done: @escaping @Sendable () -> Void) -> Void

    private let lanes: [AXLane]
    private let lock = NSLock()
    private var queued: [Work] = []
    private var idle: [Int]
    private var underWay = 0
    private var stopped = false
    private let finished = DispatchSemaphore(value: 0)

    init(lanes: [AXLane]) {
        self.lanes = lanes
        idle = Array(lanes.indices.reversed())
    }

    func submit(_ work: @escaping Work) {
        lock.withLock { queued.append(work) }
    }

    /// Starts the queued work and waits until it and everything it added are done, or `deadline`
    /// passes: then false, and work still under way is dropped as it ends.
    func run(until deadline: DispatchTime) -> Bool {
        if lock.withLock({ queued.isEmpty && underWay == 0 }) { return true }
        pump()
        if finished.wait(timeout: deadline) == .success { return true }
        lock.withLock {
            stopped = true
            queued.removeAll()
        }
        return false
    }

    private func pump() {
        var starts: [(Int, Work)] = []
        lock.withLock {
            while !stopped, !queued.isEmpty, let lane = idle.popLast() {
                starts.append((lane, queued.removeFirst()))
                underWay += 1
            }
        }
        for (lane, work) in starts {
            work(lanes[lane]) { [self] in
                let done = lock.withLock { () -> Bool in
                    idle.append(lane)
                    underWay -= 1
                    return !stopped && queued.isEmpty && underWay == 0
                }
                if done { finished.signal() } else { pump() }
            }
        }
    }
}

/// The frontmost application's tree read over several lanes at once: the same attribute request per
/// element the translator sends, answered by the device in parallel, so a snapshot costs about the
/// tree's depth in round trips instead of its size. Elements come back in the translator walk's
/// order (depth first, children as their parent lists them), so `index` means the same thing.
enum AXParallelWalk {
    struct Read {
        let element: NSObject
        /// Index of the parent in the returned order; -1 for the root.
        let parent: Int
        let depth: Int
        let values: AXValues?
    }

    struct Limits {
        var maxElements = AXTreeReader.maxElements
        var maxDepth = AXTreeReader.maxDepth
        var deadline: DispatchTime
    }

    private final class Collected: @unchecked Sendable {
        struct Entry {
            let element: NSObject
            let parent: Int
            let position: Int
            let depth: Int
            var values: AXValues?
        }
        let lock = NSLock()
        var entries: [Entry] = []
        var admitted = 1
    }

    static func run(
        root: NSObject, lanes: [AXLane], limits: Limits, children: @escaping @Sendable (AXValues) -> [NSObject]
    ) -> Result<[Read], HelperError> {
        guard !lanes.isEmpty else { return .failure(HelperError(.failed, "no accessibility lanes")) }
        let pool = AXLanePool(lanes: lanes)
        let collected = Collected()
        // SAFETY of the unchecked box: a translation object is only read until the walk returns.
        struct Element: @unchecked Sendable { let object: NSObject }
        @Sendable func read(_ element: Element, parent: Int, position: Int, depth: Int) {
            pool.submit { lane, done in
                lane.attributes(of: element.object) { values in
                    collected.lock.withLock {
                        let index = collected.entries.count
                        collected.entries.append(.init(element: element.object, parent: parent, position: position, depth: depth, values: values))
                        guard depth < limits.maxDepth, let values else { return }
                        for (offset, child) in children(values).enumerated() where collected.admitted < limits.maxElements {
                            collected.admitted += 1
                            read(Element(object: child), parent: index, position: offset, depth: depth + 1)
                        }
                    }
                    done()
                }
            }
        }
        read(Element(object: root), parent: -1, position: 0, depth: 0)
        guard pool.run(until: limits.deadline) else {
            let count = collected.lock.withLock { collected.entries.count }
            return .failure(HelperError(.failed, "the accessibility walk passed its time budget after \(count) elements"))
        }
        let entries = collected.lock.withLock { collected.entries }
        return .success(depthFirst(entries))
    }

    /// Arrival order to the translator walk's order.
    private static func depthFirst(_ entries: [Collected.Entry]) -> [Read] {
        var children = [[Int]](repeating: [], count: entries.count)
        var roots: [Int] = []
        for (index, entry) in entries.enumerated() {
            if entry.parent >= 0 { children[entry.parent].append(index) } else { roots.append(index) }
        }
        var order: [Read] = []
        order.reserveCapacity(entries.count)
        var newIndex = [Int](repeating: -1, count: entries.count)
        var stack = roots.reversed().map { ($0, -1) }
        while let (at, parent) = stack.popLast() {
            newIndex[at] = order.count
            let entry = entries[at]
            order.append(Read(element: entry.element, parent: parent, depth: entry.depth, values: entry.values))
            let mine = newIndex[at]
            for child in children[at].sorted(by: { entries[$0].position > entries[$1].position }) { stack.append((child, mine)) }
        }
        return order
    }

    /// One hit test per point, across the lanes; nil where the device did not answer.
    static func hitTests(_ points: [CGPoint], lanes: [AXLane], deadline: DispatchTime) -> [AXHit?] {
        guard !points.isEmpty, !lanes.isEmpty else { return points.map { _ in nil } }
        final class Answers: @unchecked Sendable {
            let lock = NSLock()
            var hits: [AXHit?]
            init(count: Int) { hits = Array(repeating: nil, count: count) }
        }
        let answers = Answers(count: points.count)
        let pool = AXLanePool(lanes: lanes)
        for (index, point) in points.enumerated() {
            pool.submit { lane, done in
                lane.hitTest(point) { hit in
                    answers.lock.withLock { answers.hits[index] = hit }
                    done()
                }
            }
        }
        _ = pool.run(until: deadline)
        return answers.lock.withLock { answers.hits }
    }
}
