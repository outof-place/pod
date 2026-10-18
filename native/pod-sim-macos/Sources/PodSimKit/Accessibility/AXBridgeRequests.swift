import AppKit
import Foundation

/// The translator's requests built here and sent straight to a device's accessibility service, so
/// many can be under way at once (the translator itself is single-threaded and waits on each). Seen
/// on AccessibilityPlatformTranslation 587 with iOS 26.5's CoreSimulatorBridge: request type 4 is
/// the frontmost application (`displayId`), 5 several attributes of one element (`attributes`, AXP
/// attribute numbers), 6 a hit test (`point`, `displayId`); the answer is an `AXPTranslatorResponse`
/// whose `resultData` is a translation object, or a dictionary keyed by attribute number. Values are
/// converted afterwards by the translator's own element methods, as `accessibilityMultipleAttributes:`
/// converts them, so both routes report the same elements and frames.
enum AXBridgeRequests {
    enum RequestType: Int {
        case frontmost = 4, attributes = 5, hitTest = 6
    }

    /// The attributes the walk reads, as the translator numbers them, and which one lists children.
    struct Vocabulary: Sendable {
        let attributes: [Int]
        let children: Int
    }

    /// Asked of the device by the value conversion itself, one request per element: on 587, 66
    /// (whether the element is another process's, which has no Mac name). Read with the others and
    /// answered from them (AXBatchAnswers), so converting asks the device nothing.
    static let conversionAttributes = [66]

    private static let lock = NSLock()
    nonisolated(unsafe) private static var learned: Result<Vocabulary, HelperError>?

    /// AXTreeReader's attribute names in the translator's numbering, read once from the translator
    /// itself on its queue (names it does not forward, such as AXHidden, drop out as they do in its
    /// own requests). Not to be called on the translator queue.
    static func vocabulary() -> Result<Vocabulary, HelperError> {
        if let learned = lock.withLock({ learned }) { return learned }
        let made = AXTranslatorBridge.queue.sync { learn() }
        lock.withLock { learned = made }
        return made
    }

    private static func learn() -> Result<Vocabulary, HelperError> {
        ObjCGuard.attempt("AXP attribute numbers") { () -> Result<Vocabulary, HelperError> in
            guard let element = platformElement(newTranslation()) else {
                return .failure(HelperError(.failed, "AXPMacPlatformElement made no element"))
            }
            // Also builds the translator's attribute map, which the value conversion reads.
            typealias Number = @convention(c) (AnyObject, Selector, NSString) -> UInt
            let selector = NSSelectorFromString("_attributeTypeForMacAttribute:")
            let number = unsafeBitCast(element.method(for: selector), to: Number.self)
            let attributes = AXTreeReader.attributeNames.map { Int(number(element, selector, $0 as NSString)) }.filter { $0 != 0 }
            let children = Int(number(element, selector, "AXChildren"))
            guard children != 0, attributes.contains(children) else {
                return .failure(HelperError(.failed, "the translator has no number for AXChildren"))
            }
            return .success(Vocabulary(attributes: attributes + conversionAttributes, children: children))
        }.flatMap { $0 }
    }

    static func newTranslation() -> NSObject {
        (NSClassFromString("AXPTranslationObject") as? NSObject.Type)?.init() ?? NSObject()
    }

    static func platformElement(_ translation: NSObject) -> NSObject? {
        (NSClassFromString("AXPMacPlatformElement") as? NSObject.Type)?
            .perform(NSSelectorFromString("platformElementWithTranslationObject:"), with: translation)?.takeUnretainedValue() as? NSObject
    }

    static func request(_ type: RequestType, translation: NSObject, parameters: NSDictionary) -> NSObject? {
        guard case .success(let made) = ObjCGuard.attempt("AXPTranslatorRequest", { () -> NSObject? in
            guard let request = (NSClassFromString("AXPTranslatorRequest") as? NSObject.Type)?
                .perform(NSSelectorFromString("requestWithTranslation:"), with: translation)?.takeUnretainedValue() as? NSObject
            else { return nil }
            request.setValue(type.rawValue, forKey: "requestType")
            request.setValue(parameters, forKey: "parameters")
            return request
        }) else { return nil }
        return made
    }

    static func frontmost() -> NSObject? {
        request(.frontmost, translation: newTranslation(), parameters: ["displayId": 0])
    }

    static func attributes(of element: NSObject, _ numbers: [Int]) -> NSObject? {
        request(.attributes, translation: element, parameters: ["attributes": numbers as NSArray])
    }

    static func hitTest(_ point: CGPoint) -> NSObject? {
        request(.hitTest, translation: newTranslation(), parameters: ["point": NSValue(point: point), "displayId": 0])
    }

    static func resultData(_ response: NSObject?) -> Any? {
        guard let response, case .success(let data) = ObjCGuard.attempt("resultData", { response.value(forKey: "resultData") }) else { return nil }
        return data
    }

    static func values(_ response: NSObject?) -> AXValues? {
        guard let dictionary = resultData(response) as? NSDictionary else { return nil }
        var values: AXValues = [:]
        for case let (key as NSNumber, value) in dictionary where !(value is NSNull) {
            values[key.intValue] = value
        }
        return values
    }

    static func translation(_ response: NSObject?) -> NSObject? {
        guard let object = resultData(response) as? NSObject, NSStringFromClass(type(of: object)) == "AXPTranslationObject" else { return nil }
        return object
    }

    /// The selectors and classes this route calls beyond the translator walk's.
    static func missingSymbols() -> [String] {
        var missing: [String] = []
        func instance(_ className: String, _ selectors: [String]) {
            guard let cls = NSClassFromString(className) else { return missing.append(className) }
            for name in selectors where !cls.instancesRespond(to: NSSelectorFromString(name)) { missing.append("-[\(className) \(name)]") }
        }
        func classMethod(_ className: String, _ name: String) {
            guard let cls = NSClassFromString(className) else { return }
            if !(cls as AnyObject).responds(to: NSSelectorFromString(name)) { missing.append("+[\(className) \(name)]") }
        }
        instance("AXPTranslatorRequest", ["setRequestType:", "setParameters:"])
        classMethod("AXPTranslatorRequest", "requestWithTranslation:")
        instance("AXPTranslatorRequest", ["translation", "requestType", "attributeType"])
        instance("AXPTranslatorResponse", ["resultData", "setResultData:"])
        instance("AXPTranslationObject", ["objectID", "pid", "setBridgeDelegateToken:"])
        instance("AXPMacPlatformElement", [
            "translation", "_attributeTypeForMacAttribute:", "_macAttributeTypeForAXPAttribute:",
            "_convertTranslatorResponse:forAttribute:", "_postProcessResult:attributeType:",
        ])
        classMethod("AXPMacPlatformElement", "platformElementWithTranslationObject:")
        return missing
    }
}

/// A lane over one bridge connection.
final class AXBridgeReadLane: AXLane, @unchecked Sendable {
    let lane: AXBridgeLane
    private let vocabulary: AXBridgeRequests.Vocabulary
    private let timeout: TimeInterval

    init(_ lane: AXBridgeLane, vocabulary: AXBridgeRequests.Vocabulary, timeout: TimeInterval) {
        self.lane = lane
        self.vocabulary = vocabulary
        self.timeout = timeout
    }

    func attributes(of element: NSObject, done: @escaping @Sendable (AXValues?) -> Void) {
        guard let request = AXBridgeRequests.attributes(of: element, vocabulary.attributes) else { return done(nil) }
        lane.send(request, timeout: timeout) { done(AXBridgeRequests.values($0)) }
    }

    func hitTest(_ point: CGPoint, done: @escaping @Sendable (AXHit?) -> Void) {
        guard let request = AXBridgeRequests.hitTest(point) else { return done(nil) }
        lane.send(request, timeout: timeout) { response in
            done(AXBridgeRequests.translation(response).map {
                AXHit(objectID: AXTreeReader.number($0, "objectID")?.uint64Value, pid: AXTreeReader.number($0, "pid")?.int32Value)
            })
        }
    }

    func frontmost(done: @escaping @Sendable (NSObject?) -> Void) {
        guard let request = AXBridgeRequests.frontmost() else { return done(nil) }
        lane.send(request, timeout: timeout) { done(AXBridgeRequests.translation($0)) }
    }
}

/// Raw values to the walk's elements, through the translator's element methods, on its queue. What the
/// conversion asks the device (`conversionAttributes`) is answered from the element's own values; a
/// question the read has no answer for fails the conversion.
enum AXBridgeValues {
    static func elements(_ reads: [AXParallelWalk.Read], bridge: AXTranslatorBridge, vocabulary: AXBridgeRequests.Vocabulary) -> Result<[AXRawElement], HelperError> {
        let answers = AXBatchAnswers()
        let (token, route) = bridge.register(answers, requestTimeout: 0)
        defer { bridge.unregister(token) }
        let converted = ObjCGuard.attempt("AXP value conversion") { () -> [AXRawElement] in
            typealias Convert = @convention(c) (AnyObject, Selector, AnyObject, UInt) -> AnyObject?
            typealias MacName = @convention(c) (AnyObject, Selector, UInt) -> AnyObject?
            let convert = NSSelectorFromString("_convertTranslatorResponse:forAttribute:")
            let post = NSSelectorFromString("_postProcessResult:attributeType:")
            let name = NSSelectorFromString("_macAttributeTypeForAXPAttribute:")
            return reads.map { read in
                read.element.setValue(token, forKey: "bridgeDelegateToken")
                guard let values = read.values, let element = AXBridgeRequests.platformElement(read.element) else {
                    return AXTreeReader.raw([:], depth: read.depth)
                }
                answers.current = (read.element, values)
                let first = unsafeBitCast(element.method(for: convert), to: Convert.self)
                let second = unsafeBitCast(element.method(for: post), to: Convert.self)
                let macName = unsafeBitCast(element.method(for: name), to: MacName.self)
                var named: [String: Any] = [:]
                for (key, value) in values where key != vocabulary.children && !AXBridgeRequests.conversionAttributes.contains(key) {
                    guard let attribute = macName(element, name, UInt(key)) as? String,
                          let result = first(element, convert, value as AnyObject, UInt(key)).flatMap({ second(element, post, $0, UInt(key)) }),
                          !(result is NSNull)
                    else { continue }
                    named[attribute] = result
                }
                return AXTreeReader.raw(named, depth: read.depth)
            }
        }
        // A value converted without its answer would be missing or wrong, unseen: the call reads through the translator.
        guard route.unanswered == 0 else {
            return .failure(HelperError(.failed, "converting the values asked \(route.unanswered) questions the read had no answer for"))
        }
        return converted
    }
}

/// Answers the conversion's own questions about the element being converted from the values already read.
private final class AXBatchAnswers: AXTransport, @unchecked Sendable {
    let kind = "batch"
    let brokenReason: String? = nil
    /// Set before each element is converted; only touched on the translator queue.
    var current: (element: NSObject, values: AXValues)?

    func send(_ request: AnyObject, timeout: TimeInterval) -> AnyObject? {
        guard let request = request as? NSObject, let current,
              (request.value(forKey: "requestType") as? NSNumber)?.intValue == 2,
              let attribute = (request.value(forKey: "attributeType") as? NSNumber)?.intValue,
              let value = current.values[attribute] as? NSObject,
              let asked = request.value(forKey: "translation") as? NSObject,
              AXTreeReader.number(asked, "objectID") == AXTreeReader.number(current.element, "objectID"),
              AXTreeReader.number(asked, "pid") == AXTreeReader.number(current.element, "pid"),
              let response = (NSClassFromString("AXPTranslatorResponse") as? NSObject.Type)?
                .perform(NSSelectorFromString("emptyResponse"))?.takeUnretainedValue() as? NSObject
        else { return nil }
        // emptyResponse makes a new object each call (a shared one would carry this value to the next).
        response.setValue(value, forKey: "resultData")
        return response
    }

    func close() {}
}
