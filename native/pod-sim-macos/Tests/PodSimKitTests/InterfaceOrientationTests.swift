import CoreGraphics
import Foundation
import Testing
@testable import PodSimKit

@Suite("Interface orientation")
struct InterfaceOrientationTests {
    /// iPhone 16 Pro and a 13-inch iPad, native (portrait) points.
    let phone = CGSize(width: 402, height: 874)
    let pad = CGSize(width: 1032, height: 1376)

    private func device(_ object: NSObject) -> SimDeviceHandle {
        SimDeviceHandle(object: object, udid: "8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", name: "iPhone 16 Pro", state: "Booted", screenPixels: CGSize(width: 1206, height: 2622))
    }

    @Test("the application element's size says portrait or landscape; a window that fits neither way is unknown")
    func fromRootSize() {
        #expect(InterfaceOrientation.of(root: CGSize(width: 402, height: 874), native: phone) == .portrait)
        #expect(InterfaceOrientation.of(root: CGSize(width: 874, height: 402), native: phone) == .landscape)
        // Split View spans the screen's height: half of a portrait or a landscape iPad.
        #expect(InterfaceOrientation.of(root: CGSize(width: 507, height: 1376), native: pad) == .portrait)
        #expect(InterfaceOrientation.of(root: CGSize(width: 688, height: 1032), native: pad) == .landscape)
        #expect(InterfaceOrientation.of(root: CGSize(width: 320, height: 900), native: pad) == nil)
        #expect(InterfaceOrientation.of(root: .zero, native: phone) == nil)
    }

    @Test("in landscape, actions that start a contact are refused as unsupported; a touch already down may finish, keys and buttons go")
    func gate() {
        let at = DevicePoint(x: 100, y: 100)
        let starts: [HIDAction] = [
            .tap(at, holdMs: 60), .longPress(at, durationMs: 1_000), .swipe(from: at, to: DevicePoint(x: 100, y: 300), durationMs: 300, edge: nil),
            .drag(from: at, to: DevicePoint(x: 200, y: 100), pressMs: 600, durationMs: 500, releaseMs: 200),
            .pinch(centre: at, fromSpan: 50, toSpan: 100, durationMs: 400, angle: 0), .touch(phase: .down, points: [at], edge: nil),
        ]
        for action in starts {
            let refused = OrientationGate.refusal(action, orientation: .landscape)
            #expect(refused?.code == .unsupported, "\(action.kind)")
            #expect(refused?.message.contains("landscape") == true)
            #expect(OrientationGate.refusal(action, orientation: .portrait) == nil)
            #expect(OrientationGate.refusal(action, orientation: nil) == nil)
        }
        let carryOn: [HIDAction] = [
            .touch(phase: .move, points: [at], edge: nil), .touch(phase: .up, points: [at], edge: nil),
            .text("hello", via: .auto), .key(usage: 40, modifiers: [], phase: .press), .button(.home, holdMs: 100),
        ]
        for action in carryOn {
            #expect(OrientationGate.refusal(action, orientation: .landscape) == nil, "\(action.kind)")
        }
    }

    @Test("a device's orientation is its latest snapshot's, and a reboot (another device object) forgets it")
    func perDevice() {
        let orientations = DeviceOrientations()
        let booted = NSObject()
        orientations.record(.landscape, for: device(booted))
        #expect(orientations.latest(device(booted)) == .landscape)
        orientations.record(.portrait, for: device(booted))
        #expect(orientations.latest(device(booted)) == .portrait)
        orientations.record(.landscape, for: device(booted))
        #expect(orientations.latest(device(NSObject())) == nil)
    }
}
