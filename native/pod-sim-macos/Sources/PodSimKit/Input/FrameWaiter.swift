import Foundation

/// Times "input to first damage": screen callbacks on the device's main display, armed at the first
/// event, and the first frame after it. Measurement only (`waitForFrameMs`); a screen that animates
/// anyway (a caret, a spinner) answers early, so callers measure on a still screen.
final class FrameWaiter: @unchecked Sendable {
    private let port: DisplayPort
    private let token = UUID()
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var armedAt: UInt64?
    private var firstFrameAt: UInt64?
    private let arrived = DispatchSemaphore(value: 0)

    private init(port: DisplayPort) {
        self.port = port
        queue = DispatchQueue(label: "pod-sim.input.frames.\(port.udid)", qos: .userInteractive)
    }

    static func start(_ device: SimDeviceHandle) -> Result<FrameWaiter, HelperError> {
        DisplayPort.main(of: device).flatMap { port in
            let waiter = FrameWaiter(port: port)
            return port.registerCallbacks(
                token: waiter.token, queue: waiter.queue,
                onFrame: { [weak waiter] in waiter?.frame() },
                onSurface: { _ in }
            ).map { waiter }
        }
    }

    /// Marks the moment the first event went out.
    func arm() {
        lock.withLock { armedAt = DispatchTime.now().uptimeNanoseconds }
    }

    /// Milliseconds from `arm` to the first frame, waiting until `limitMs` after `arm`; nil when none came.
    func wait(limitMs: Int) -> Double? {
        let armed = lock.withLock { armedAt } ?? DispatchTime.now().uptimeNanoseconds
        _ = arrived.wait(timeout: DispatchTime(uptimeNanoseconds: armed + UInt64(limitMs) * 1_000_000))
        port.unregisterCallbacks(token: token)
        queue.sync {}
        return lock.withLock {
            guard let armedAt, let firstFrameAt else { return nil }
            return (Double(firstFrameAt - armedAt) / 1_000_000 * 10).rounded() / 10
        }
    }

    func cancel() {
        port.unregisterCallbacks(token: token)
    }

    private func frame() {
        let now = DispatchTime.now().uptimeNanoseconds
        let first = lock.withLock { () -> Bool in
            guard let armedAt, firstFrameAt == nil, now >= armedAt else { return false }
            firstFrameAt = now
            return true
        }
        if first { arrived.signal() }
    }
}
