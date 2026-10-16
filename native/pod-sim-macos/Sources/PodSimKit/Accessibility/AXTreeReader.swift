import AppKit
import Foundation

/// What one walk of the frontmost application's tree read, before normalization.
struct AXWalk {
    var elements: [AXRawElement]
    /// The application's process, from its translation object.
    var appPid: Int32?
    /// Points the root reports for the screen (the application element spans it).
    var rootFrame: CGRect?
    var requests: Int
    var timings = AXWalkTimings()
}

/// Where one snapshot's time went, per phase: each translator call costs at least one round trip to
/// the device's accessibility server.
struct AXWalkTimings: Equatable {
    var frontmostMs = 0.0
    var attributeCalls = 0
    var attributesMs = 0.0
    var hitTests = 0
    var hitTestsMs = 0.0
}

/// Reads the frontmost application's tree through the translator: one batched attribute request per
/// element (`accessibilityMultipleAttributes:`, as idb v1.7.2 `AXElementSnapshot` reads), then a hit
/// test where an element may be covered (`hitPoints`) so a covered one is not offered as tappable.
/// Runs on the translator queue.
enum AXTreeReader {
    static let attributeNames = ["AXFrame", "AXRole", "AXDescription", "AXValue", "AXIdentifier", "AXEnabled", "AXFocused", "AXHidden", "AXTraits", "AXChildren"]
    static let maxElements = 2_000
    static let maxDepth = 80

    struct Limits {
        var deadline: DispatchTime
        var hitTest: Bool
        /// With a filter only the elements it matches are hit-tested: the others are never listed,
        /// and covering changes nothing the fingerprint reads.
        var filter: String? = nil
    }

    private final class Node {
        let element: NSObject
        let objectID: UInt64?
        let pid: Int32?
        var raw: AXRawElement
        var subtree: Set<UInt64> = []
        var ancestors: Set<UInt64> = []
        init(element: NSObject, objectID: UInt64?, pid: Int32?, raw: AXRawElement) {
            self.element = element
            self.objectID = objectID
            self.pid = pid
            self.raw = raw
        }
    }

    static func walk(bridge: AXTranslatorBridge, token: String, screenPoints: CGSize, limits: Limits) -> Result<AXWalk, HelperError> {
        guard let translator = bridge.translator else { return .failure(HelperError(.failed, "the translator is not loaded")) }
        return ObjCGuard.attempt("accessibility walk") { () -> Result<AXWalk, HelperError> in
            var timings = AXWalkTimings()
            var phaseStart = DispatchTime.now()
            func phaseMs() -> Double {
                let now = DispatchTime.now()
                defer { phaseStart = now }
                return Double(now.uptimeNanoseconds - phaseStart.uptimeNanoseconds) / 1_000_000
            }
            typealias Front = @convention(c) (AnyObject, Selector, UInt32, NSString) -> AnyObject?
            let frontSelector = NSSelectorFromString("frontmostApplicationWithDisplayId:bridgeDelegateToken:")
            let front = unsafeBitCast(translator.method(for: frontSelector), to: Front.self)
            guard let translation = front(translator, frontSelector, 0, token as NSString) as? NSObject else {
                return .failure(HelperError(.failed, "no frontmost application answered (the device may still be starting)"))
            }
            guard let root = element(of: translation, translator: translator, token: token) else {
                return .failure(HelperError(.failed, "the translator made no element for the frontmost application"))
            }
            var nodes: [Node] = []
            var requests = 1
            var parents: [Int] = []
            func visit(_ object: NSObject, depth: Int, parent: Int?) -> Bool {
                guard nodes.count < maxElements, depth <= maxDepth else { return true }
                if DispatchTime.now() > limits.deadline { return false }
                setToken(token, on: object)
                let values = attributes(of: object)
                requests += 1
                let translationObject = object.value(forKey: "translation") as? NSObject
                let node = Node(
                    element: object, objectID: number(translationObject, "objectID")?.uint64Value,
                    pid: number(translationObject, "pid")?.int32Value, raw: raw(values, depth: depth))
                let index = nodes.count
                nodes.append(node)
                parents.append(parent ?? -1)
                for child in (values["AXChildren"] as? [Any] ?? []).compactMap({ $0 as? NSObject }) {
                    if !visit(child, depth: depth + 1, parent: index) { return false }
                }
                return true
            }
            timings.frontmostMs = phaseMs()
            guard visit(root, depth: 0, parent: nil) else {
                return .failure(HelperError(.failed, "the accessibility walk passed its time budget after \(nodes.count) elements"))
            }
            timings.attributeCalls = nodes.count
            timings.attributesMs = phaseMs()
            // Each element's own id plus its descendants' and ancestors': a hit on any of them lands on
            // it (a container answers for children that are not hit-testable themselves).
            for index in nodes.indices.reversed() {
                if let id = nodes[index].objectID { nodes[index].subtree.insert(id) }
                if parents[index] >= 0 { nodes[parents[index]].subtree.formUnion(nodes[index].subtree) }
            }
            for index in nodes.indices where parents[index] >= 0 {
                let parent = nodes[parents[index]]
                nodes[index].ancestors = parent.ancestors.union(parent.objectID.map { [$0] } ?? [])
            }
            let appPid = nodes.first?.pid
            // The application element spans the screen in the app's orientation, the frames' space.
            let rootSize = nodes.first.map { AXNormalizer.finite($0.raw.frame).size }.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            let screen = CGRect(origin: .zero, size: rootSize ?? screenPoints)
            if limits.hitTest {
                let points = hitPoints(nodes.map(\.raw), parents: parents, screen: screen, filter: limits.filter)
                for (node, point) in zip(nodes, points) {
                    guard let point else { continue }
                    if DispatchTime.now() > limits.deadline { break }
                    let hit = hitTest(point, translator: translator, token: token)
                    requests += 1
                    timings.hitTests += 1
                    if let hit { node.raw.hitsItself = lands(hit, on: node, root: nodes.first?.objectID) }
                }
            }
            timings.hitTestsMs = phaseMs()
            return .success(AXWalk(
                elements: nodes.map(\.raw), appPid: appPid, rootFrame: nodes.first?.raw.frame, requests: requests, timings: timings))
        }.flatMap { $0 }
    }

    /// Where to hit-test each element (index 0 is the application), or nil where the answer could
    /// change nothing: the element is not listed (hidden, off screen, outside the filter), or no other
    /// element of the walk outside its own ancestors and descendants spans that point, so a hit could
    /// only land on its own family. Each hit test is a round trip to the device (about 4 ms in
    /// Settings on iOS 26.5), so testing only where something may cover saves most of them.
    static func hitPoints(_ elements: [AXRawElement], parents: [Int], screen: CGRect, filter: String?) -> [CGPoint?] {
        func isAncestor(_ ancestor: Int, of index: Int) -> Bool {
            var at = parents[index]
            while at >= 0 {
                if at == ancestor { return true }
                at = parents[at]
            }
            return false
        }
        let frames = elements.map { AXNormalizer.finite($0.frame).standardized }
        return elements.indices.map { index in
            guard index > 0, let point = hitPoint(elements[index], screen: screen, filter: filter) else { return nil }
            let mayCover = elements.indices.contains { other in
                other > 0 && other != index && !elements[other].hidden && frames[other].width > 0 && frames[other].height > 0
                    && frames[other].contains(point) && !isAncestor(other, of: index) && !isAncestor(index, of: other)
            }
            return mayCover ? point : nil
        }
    }

    /// The middle of an element's on-screen part, as its centre, when it could be listed: not hidden,
    /// on screen, matching the filter.
    static func hitPoint(_ element: AXRawElement, screen: CGRect, filter: String?) -> CGPoint? {
        guard !element.hidden else { return nil }
        if let filter, !AXNormalizer.matches(element, filter) { return nil }
        let visiblePart = AXNormalizer.finite(element.frame).standardized.intersection(screen)
        guard !visiblePart.isNull, visiblePart.width >= 1, visiblePart.height >= 1 else { return nil }
        return CGPoint(x: visiblePart.midX, y: visiblePart.midY)
    }

    /// The frontmost application's process: one request, for callers that only need to know whether
    /// it changed (a system alert taking over the screen is SpringBoard's).
    static func frontmostPid(bridge: AXTranslatorBridge, token: String) -> Int32? {
        guard let translator = bridge.translator else { return nil }
        let read = ObjCGuard.attempt("frontmost application") { () -> Int32? in
            typealias Front = @convention(c) (AnyObject, Selector, UInt32, NSString) -> AnyObject?
            let selector = NSSelectorFromString("frontmostApplicationWithDisplayId:bridgeDelegateToken:")
            let front = unsafeBitCast(translator.method(for: selector), to: Front.self)
            return number(front(translator, selector, 0, token as NSString) as? NSObject, "pid")?.int32Value
        }
        guard case .success(let pid) = read else { return nil }
        return pid
    }

    private static func element(of translation: NSObject, translator: NSObject, token: String) -> NSObject? {
        translation.setValue(token, forKey: "bridgeDelegateToken")
        typealias Make = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        let selector = NSSelectorFromString("macPlatformElementFromTranslation:")
        let made = unsafeBitCast(translator.method(for: selector), to: Make.self)(translator, selector, translation) as? NSObject
        if let made { setToken(token, on: made) }
        return made
    }

    private static func setToken(_ token: String, on element: NSObject) {
        (element.value(forKey: "translation") as? NSObject)?.setValue(token, forKey: "bridgeDelegateToken")
    }

    private static func attributes(of element: NSObject) -> [String: Any] {
        let selector = NSSelectorFromString("accessibilityMultipleAttributes:")
        guard let raw = element.perform(selector, with: attributeNames as NSArray)?.takeUnretainedValue() as? NSDictionary else { return [:] }
        var values: [String: Any] = [:]
        for (key, value) in raw {
            guard let key = key as? String, !(value is NSNull) else { continue }
            values[key] = value
        }
        return values
    }

    private static func raw(_ values: [String: Any], depth: Int) -> AXRawElement {
        AXRawElement(
            role: values["AXRole"] as? String ?? "AXUnknown",
            label: text(values["AXDescription"]),
            value: text(values["AXValue"]),
            identifier: text(values["AXIdentifier"]),
            frame: (values["AXFrame"] as? NSValue)?.rectValue ?? .zero,
            enabled: (values["AXEnabled"] as? NSNumber)?.boolValue,
            focused: (values["AXFocused"] as? NSNumber)?.boolValue,
            hidden: (values["AXHidden"] as? NSNumber)?.boolValue ?? false,
            traits: (values["AXTraits"] as? NSNumber)?.uint64Value,
            depth: depth)
    }

    /// Strings as they are; numbers (a slider, a switch) as their text; anything else is no value.
    private static func text(_ value: Any?) -> String? {
        switch value {
        case let string as String: string.isEmpty ? nil : string
        case let attributed as NSAttributedString: attributed.string.isEmpty ? nil : attributed.string
        case let number as NSNumber: number.stringValue
        default: nil
        }
    }

    private static func number(_ object: NSObject?, _ key: String) -> NSNumber? {
        guard let object, object.responds(to: NSSelectorFromString(key)) else { return nil }
        return object.value(forKey: key) as? NSNumber
    }

    /// Whether a hit at a node's centre lands on it; nil when the walk cannot tell. Content another
    /// process draws inside the app (a widget, web content) answers hit tests with ids this walk never
    /// saw, so only the app's own elements count as covering it.
    private static func lands(_ hit: Hit, on node: Node, root: UInt64?) -> Bool? {
        // The application element answers where nothing accessible is: no evidence either way.
        guard let id = hit.objectID, id != root else { return nil }
        if node.subtree.contains(id) || node.ancestors.contains(id) { return true }
        if let hitPid = hit.pid, let pid = node.pid, hitPid != pid { return nil }
        return false
    }

    private struct Hit {
        let objectID: UInt64?
        let pid: Int32?
    }

    private static func hitTest(_ point: CGPoint, translator: NSObject, token: String) -> Hit? {
        typealias At = @convention(c) (AnyObject, Selector, CGPoint, UInt32, NSString) -> AnyObject?
        let selector = NSSelectorFromString("objectAtPoint:displayId:bridgeDelegateToken:")
        guard let hit = unsafeBitCast(translator.method(for: selector), to: At.self)(translator, selector, point, 0, token as NSString) as? NSObject
        else { return nil }
        return Hit(objectID: number(hit, "objectID")?.uint64Value, pid: number(hit, "pid")?.int32Value)
    }
}
