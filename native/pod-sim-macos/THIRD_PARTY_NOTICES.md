# Third-party notices

## idb

Source: https://github.com/facebook/idb, tag v1.7.2, commit 33a400490a1f53f81e070474435bef8ef10b30b4.

Ported shapes (rewritten in this package, no file copied):

- The Objective-C exception guard around private calls (`FBControlCoreObjC/FBObjCExceptionGuard.m`) as `Sources/CPodSimObjC/PodSimObjCGuard.m`.
- The `SimScreen` callback signatures and the main-display rule (`PrivateHeaders/CoreSimDeviceIO/SimScreen-Protocol.h`, `SimDisplayDescriptorState-Protocol.h`, `FBSimulatorControl/Framebuffer/FramebufferSurface.swift`) in `Sources/PodSimKit/Display/`.
- SimulatorKit's location per Xcode (`FBControlCore/Utility/WeakFramework.swift`) and the resolved device-set path (`FBSimulatorControl/Management/SimulatorServiceContext.swift`) in `Sources/PodSimKit/Xcode/` and `Sources/PodSimKit/CoreSimulator/`.
- Framebuffer rendering: sRGB interpretation, one shared `CIContext`, Lanczos scaling (`FBSimulatorControl/Framebuffer/SurfaceImageGenerator.swift`) in `Sources/PodSimKit/Screenshot/ImageWriter.swift`.
- Input over DTUHID: the host XPC connection to a device service (`FBSimulatorControl/XPC/SimulatorXPCConnection.swift`: `-[SimDevice lookup:error:]`, the `_4sim` endpoint calls) in `Sources/PodSimKit/Input/SimXPCService.swift`; the message envelope, digitizer, keyboard and button payloads and the liveness barrier (`FBSimulatorControl/HID/SimulatorDTUHIDConnection.swift`, `DTUHIDModels.swift`) in `Sources/PodSimKit/Input/DTUHIDTransport.swift`; the hardware button usages, the edge flag and the swipe shape (`FBSimulatorControl/HID/SimulatorHIDButtonIdentity.swift`, `SimulatorHIDEvent.swift`, `SimulatorDigitizerHIDTransport.swift`) in `Sources/PodSimKit/Input/HIDAction.swift` and `HIDPlan.swift`.
- Accessibility: the translator set-up, its delegate callbacks and the token routing per device (`FBSimulatorAX/AXTranslationDispatcher.swift`, `Commands/SimulatorAccessibilityCommands.swift`) in `Sources/PodSimKit/Accessibility/AXTranslatorBridge.swift`; the batched attribute read and the hit test (`AXPlatformElement.swift`, `AXRawTranslationReader.swift`) in `AXTreeReader.swift`; the direct transport to `com.apple.CoreSimulator.accessibility` (`AXTranslationTransport.swift`, `AXTranslationRequest.swift`) in `AXTransport.swift`; the UIKit trait bits (`AXWire+AXKeys.swift`) in `AXSnapshotModel.swift` and `AXFingerprint.swift`.

```
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## serve-sim

The fallback rule "the framebuffer the size of the device's screen" came from serve-sim (commit 6d009686, Apache-2.0) through the stage 0 spike. No serve-sim code is included.
