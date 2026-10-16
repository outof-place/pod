import Foundation

/// The self-test's `hid` checks: libxpc's `_4sim` calls and `-[SimDevice lookup:error:]` exist, then
/// (on a booted device) `dtuhidd` answers a barrier. The barrier carries usage 0, so the device sees
/// no input; the connection stays open for the first real call.
enum InputProbes {
    static func symbols() -> ProbeOutcome {
        let missing = DTUHIDTransport.missingSymbols()
        return missing.isEmpty ? .passed(checked: .symbols, note: nil) : .failed(checked: .symbols, reason: "missing \(missing.joined(separator: ", "))")
    }

    static func device(_ device: SimDeviceHandle) -> ProbeOutcome {
        let started = DispatchTime.now()
        switch InputSessions.shared.session(for: device) {
        case .failure(let error):
            return .failed(checked: .device, reason: error.message)
        case .success:
            let ms = Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
            return .passed(checked: .device, note: "dtuhidd answered a barrier through \(DTUHIDTransport.service) in \(ms) ms")
        }
    }
}
