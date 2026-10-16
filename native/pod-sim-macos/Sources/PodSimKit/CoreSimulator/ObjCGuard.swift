import CPodSimObjC
import Foundation

enum ObjCGuard {
    /// Runs a call into a private framework; a raised Objective-C exception becomes `.failed`.
    static func attempt<T>(_ what: String, _ body: () -> T) -> Result<T, HelperError> {
        var value: T?
        var reason: NSString?
        let ok = PodSimObjCTry({ value = body() }, &reason)
        guard ok, let value else {
            return .failure(HelperError(.failed, "\(what) raised \(reason.map(String.init) ?? "an exception")"))
        }
        return .success(value)
    }
}

/// An object CoreSimulator handed out; touched only on queues this helper controls.
struct ObjCHandle: @unchecked Sendable {
    let object: NSObject
}
