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
}

/// Reads the frontmost application's tree through the translator: one batched attribute request per
/// element (`accessibilityMultipleAttributes:`, as idb v1.7.2 `AXElementSnapshot` reads), then one hit
/// test per on-screen element so a covered one is not offered as tappable. Runs on the translator queue.
enum AXTreeReader {
    static let attributeNames = ["AXFrame", "AXRole", "AXDescription", "AXValue", "AXIdentifier", "AXEnabled", "AXFocused", "AXHidden", "AXTraits", "AXChildren"]
    static let maxElements = 2_000
    static let maxDepth = 80

    struct Limits {
        var deadline: DispatchTime
        var hitTest: Bool
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
            guard visit(root, depth: 0, parent: nil) else {
                return .failure(HelperError(.failed, "the accessibility walk passed its time budget after \(nodes.count) elements"))
            }
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
            let screen = CGRect(origin: .zero, size: screenPoints)
            if limits.hitTest {
                for node in nodes.dropFirst() where !node.raw.hidden {
                    let visiblePart = node.raw.frame.standardized.intersection(screen)
                    guard !visiblePart.isNull, visiblePart.width >= 1, visiblePart.height >= 1 else { continue }
                    if DispatchTime.now() > limits.deadline { break }
                    let hit = hitTest(CGPoint(x: visiblePart.midX, y: visiblePart.midY), translator: translator, token: token)
                    requests += 1
                    if let hit { node.raw.hitsItself = lands(hit, on: node, root: nodes.first?.objectID) }
                }
            }
            return .success(AXWalk(
                elements: nodes.map(\.raw), appPid: appPid, rootFrame: nodes.first?.raw.frame, requests: requests))
        }.flatMap { $0 }
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
