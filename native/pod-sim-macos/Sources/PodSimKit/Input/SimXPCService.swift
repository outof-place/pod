import Foundation
import XPC

/// A host XPC connection to a service inside a booted simulator, as idb v1.7.2
/// (`SimulatorXPCConnection`, MIT) makes one: `-[SimDevice lookup:error:]` hands out the service's
/// Mach port, libxpc's private `_4sim` calls wrap it in an endpoint and mark the connection
/// simulator-to-host. Once connected, messages go straight to the device, past CoreSimulatorService
/// (which stalls for seconds when many tools call it at once).
enum SimXPCService {
    private struct Calls {
        typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
        typealias ConnectionFromEndpoint = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
        typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void
        let endpoint: EndpointFromPort
        let connection: ConnectionFromEndpoint
        let sim2host: EnableSim2Host

        static let resolved: Calls? = {
            let handle = dlopen(nil, RTLD_NOW)
            guard let endpoint = dlsym(handle, "xpc_endpoint_create_mach_port_4sim"),
                  let connection = dlsym(handle, "xpc_connection_create_from_endpoint"),
                  let sim2host = dlsym(handle, "xpc_connection_enable_sim2host_4sim")
            else { return nil }
            return Calls(
                endpoint: unsafeBitCast(endpoint, to: EndpointFromPort.self),
                connection: unsafeBitCast(connection, to: ConnectionFromEndpoint.self),
                sim2host: unsafeBitCast(sim2host, to: EnableSim2Host.self))
        }()
    }

    static func missingSymbols() -> [String] {
        var missing: [String] = []
        if Calls.resolved == nil {
            missing.append("libxpc xpc_endpoint_create_mach_port_4sim / xpc_connection_enable_sim2host_4sim")
        }
        if let device = NSClassFromString("SimDevice"), !device.instancesRespond(to: NSSelectorFromString("lookup:error:")) {
            missing.append("-[SimDevice lookup:error:]")
        }
        return missing
    }

    /// A resumed connection whose errors reach `onError` ("invalid" or "interrupted"), on `queue`.
    static func connect(
        _ device: SimDeviceHandle, service: String, queue: DispatchQueue, onError: @escaping @Sendable (String) -> Void
    ) -> Result<xpc_connection_t, HelperError> {
        guard let calls = Calls.resolved else {
            return .failure(HelperError(.failed, "libxpc has no _4sim endpoint calls on this macOS"))
        }
        let looked = ObjCGuard.attempt("-[SimDevice lookup:error:]") { () -> Result<mach_port_t, HelperError> in
            typealias Lookup = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> UInt32
            let selector = NSSelectorFromString("lookup:error:")
            var error: NSError?
            let port = unsafeBitCast(device.object.method(for: selector), to: Lookup.self)(device.object, selector, service as NSString, &error)
            guard port != 0 else {
                return .failure(HelperError(.failed, "no \(service) in \(device.name): \(error?.localizedDescription ?? "lookup answered 0")"))
            }
            return .success(port)
        }.flatMap { $0 }
        let port: mach_port_t
        switch looked {
        case .failure(let error): return .failure(error)
        case .success(let found): port = found
        }
        // Both calls hand back +1 objects (idb takes them retained too).
        guard let endpoint = calls.endpoint(port, 0, 0)?.takeRetainedValue() as? xpc_object_t,
              let connection = calls.connection(endpoint)?.takeRetainedValue() as? xpc_connection_t
        else { return .failure(HelperError(.failed, "libxpc made no connection for \(service)")) }
        calls.sim2host(connection)
        xpc_connection_set_target_queue(connection, queue)
        xpc_connection_set_event_handler(connection) { event in
            guard xpc_get_type(event) == XPC_TYPE_ERROR else { return }
            onError(event === XPC_ERROR_CONNECTION_INVALID ? "the \(service) connection is invalid" : "the \(service) connection was interrupted")
        }
        xpc_connection_resume(connection)
        return .success(connection)
    }

    /// One request and its reply, or nil when no reply came within `timeout` or XPC answered an error.
    static func request(_ connection: xpc_connection_t, _ message: xpc_object_t, timeout: TimeInterval) -> xpc_object_t? {
        let answered = DispatchSemaphore(value: 0)
        let box = ReplyBox()
        xpc_connection_send_message_with_reply(connection, message, DispatchQueue.global(qos: .userInitiated)) { reply in
            box.set(xpc_get_type(reply) == XPC_TYPE_ERROR ? nil : reply)
            answered.signal()
        }
        guard answered.wait(timeout: .now() + timeout) == .success else { return nil }
        return box.value
    }
}

private final class ReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: xpc_object_t?
    func set(_ reply: xpc_object_t?) { lock.withLock { stored = reply } }
    var value: xpc_object_t? { lock.withLock { stored } }
}
