// keylat: keystroke-to-pixels latency of a terminal window, the same way for every app.
// Posts a key with CGEvent and timestamps it, captures a small screen region with
// ScreenCaptureKit at the display's refresh rate, and reports the display time of the first
// frame whose pixels differ from the frame before the key. Then erases the glyph and repeats.
//
//   keylat --preflight                         permissions and displays; never prompts
//   keylat --self-test                         the frame-diff detector on synthetic frames
//   keylat --probe-post                        does CGEventPostToPid reach an inactive app's key window?
//   keylat --windows-of PID                    that process's on-screen windows (global points)
//   keylat --activate PID                      bring that process to the front (visible runs only)
//   keylat --rect X,Y,W,H [--display ID] [--pid PID] [--count 60] [--out FILE]
//
// --rect is in points, relative to the display's origin; it must cover the cursor cell and
// nothing that changes on its own (cursor blink off, no clocks). Without --pid the key goes to
// the HID event tap, so the target window must be focused.
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func ticksToMs(_ ticks: UInt64) -> Double { Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1e6 }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("keylat: \(message)\n".data(using: .utf8)!)
  exit(1)
}

func option(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[index + 1]
}

func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func printJSON(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
  if let out = option("--out") {
    FileManager.default.createFile(atPath: out, contents: data)
  }
  print(String(data: data, encoding: .utf8)!)
}

// MARK: frame diff

/** A copy of one BGRA frame, compared row by row so stride padding never counts. */
struct Frame {
  let width: Int
  let height: Int
  let rowBytes: Int
  let bytes: [UInt8]

  init(width: Int, height: Int, rowBytes: Int, bytes: [UInt8]) {
    self.width = width
    self.height = height
    self.rowBytes = rowBytes
    self.bytes = bytes
  }

  init?(pixelBuffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    width = CVPixelBufferGetWidth(pixelBuffer)
    height = CVPixelBufferGetHeight(pixelBuffer)
    rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
    bytes = Array(UnsafeRawBufferPointer(start: base, count: rowBytes * height))
  }

  /** Pixels that differ from `other` (0 when sizes differ, which never happens within one stream). */
  func changedPixels(from other: Frame) -> Int {
    guard width == other.width, height == other.height else { return 0 }
    var changed = 0
    bytes.withUnsafeBufferPointer { a in
      other.bytes.withUnsafeBufferPointer { b in
        for row in 0..<height {
          let start = row * rowBytes
          if memcmp(a.baseAddress! + start, b.baseAddress! + other.rowBytes * row, width * 4) == 0 { continue }
          for x in 0..<width where a[start + x * 4] != b[other.rowBytes * row + x * 4] || a[start + x * 4 + 1] != b[other.rowBytes * row + x * 4 + 1] || a[start + x * 4 + 2] != b[other.rowBytes * row + x * 4 + 2] {
            changed += 1
          }
        }
      }
    }
    return changed
  }
}

// MARK: preflight

func preflight() {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16)
  var count: UInt32 = 0
  CGGetOnlineDisplayList(16, &ids, &count)
  let displays: [[String: Any]] = (0..<Int(count)).map { index in
    let id = ids[index]
    let bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    return [
      "id": Int(id), "main": CGDisplayIsMain(id) != 0, "builtin": CGDisplayIsBuiltin(id) != 0,
      "bounds": [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height],
      "refreshHz": mode?.refreshRate ?? 0, "pixels": [mode?.pixelWidth ?? 0, mode?.pixelHeight ?? 0]
    ]
  }
  printJSON([
    "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
    "postEventAccess": CGPreflightPostEventAccess(),
    "virtualDisplayApi": ["CGVirtualDisplay", "CGVirtualDisplayDescriptor", "CGVirtualDisplaySettings", "CGVirtualDisplayMode"].allSatisfy { NSClassFromString($0) != nil },
    "displays": displays
  ])
}

func selfTest() {
  let width = 64, height = 16, rowBytes = 64 * 4 + 32
  var pixels = [UInt8](repeating: 30, count: rowBytes * height)
  let base = Frame(width: width, height: height, rowBytes: rowBytes, bytes: pixels)
  // Stride padding only: must not count.
  for row in 0..<height { pixels[row * rowBytes + width * 4 + 5] = 99 }
  let padded = Frame(width: width, height: height, rowBytes: rowBytes, bytes: pixels)
  // A 3x5 "glyph".
  for y in 4..<9 { for x in 10..<13 { pixels[y * rowBytes + x * 4 + 1] = 200 } }
  let glyph = Frame(width: width, height: height, rowBytes: rowBytes, bytes: pixels)
  let results: [String: Any] = [
    "paddingOnlyChanged": padded.changedPixels(from: base),
    "glyphChanged": glyph.changedPixels(from: base),
    "ticksToMsOf1s": ticksToMs(UInt64(1e9) * UInt64(timebase.denom) / UInt64(timebase.numer))
  ]
  let ok = (results["paddingOnlyChanged"] as! Int) == 0 && (results["glyphChanged"] as! Int) == 15
  printJSON(["ok": ok, "results": results])
  exit(ok ? 0 : 1)
}

// MARK: key posting

let kVKx: CGKeyCode = 0x07
let kVKDelete: CGKeyCode = 0x33

func postKey(_ key: CGKeyCode, pid: pid_t?) {
  let source = CGEventSource(stateID: .hidSystemState)
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { fail("CGEvent") }
  if let pid {
    down.postToPid(pid)
    up.postToPid(pid)
  } else {
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }
}

final class KeyCatcher: NSView {
  var received: [String] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) { received.append(event.charactersIgnoringModifiers ?? "?") }
}

final class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
}

/** A borderless window far outside every display, in this accessory (Dock-less, inactive) process. */
func probePost() {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let window = KeyWindow(contentRect: NSRect(x: -30000, y: -30000, width: 200, height: 100), styleMask: [.borderless], backing: .buffered, defer: false)
  let view = KeyCatcher(frame: window.contentLayoutRect)
  window.contentView = view
  window.orderFrontRegardless()
  window.makeKey()
  window.makeFirstResponder(view)
  RunLoop.current.run(until: Date().addingTimeInterval(0.3))
  let pid = ProcessInfo.processInfo.processIdentifier
  postKey(kVKx, pid: pid)
  RunLoop.current.run(until: Date().addingTimeInterval(1.0))
  printJSON([
    "appActive": app.isActive,
    "windowIsKey": window.isKeyWindow,
    "windowOnAnyScreen": window.screen != nil,
    "keyDownsReceived": view.received,
    "postToPidReachedInactiveApp": !view.received.isEmpty
  ])
  window.orderOut(nil)
}

// MARK: capture

final class RegionStream: NSObject, SCStreamOutput, SCStreamDelegate {
  private let lock = NSLock()
  private var frames: [(displayTime: UInt64, arrival: UInt64, frame: Frame)] = []
  private(set) var completeFrames = 0
  var stopError: Error?

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    let arrival = mach_absolute_time()
    guard type == .screen,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let info = attachments.first,
          let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
          let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
          let frame = Frame(pixelBuffer: pixelBuffer) else { return }
    let displayTime = (info[.displayTime] as? UInt64) ?? arrival
    lock.lock()
    frames.append((displayTime, arrival, frame))
    if frames.count > 240 { frames.removeFirst(frames.count - 240) }
    completeFrames += 1
    lock.unlock()
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { stopError = error }

  func latest() -> (displayTime: UInt64, arrival: UInt64, frame: Frame)? {
    lock.lock()
    defer { lock.unlock() }
    return frames.last
  }

  /** Frames that completed after `ticks`, oldest first. */
  func frames(after ticks: UInt64) -> [(displayTime: UInt64, arrival: UInt64, frame: Frame)] {
    lock.lock()
    defer { lock.unlock() }
    return frames.filter { $0.arrival > ticks }
  }
}

func sleepMs(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

/** Waits until no frame has arrived for `quietMs`, then returns the last one as the reference. */
func waitForStill(_ stream: RegionStream, quietMs: Double, timeoutMs: Double) -> Frame? {
  let start = mach_absolute_time()
  while ticksToMs(mach_absolute_time() - start) < timeoutMs {
    if let last = stream.latest(), ticksToMs(mach_absolute_time() - last.arrival) >= quietMs { return last.frame }
    sleepMs(10)
  }
  return stream.latest()?.frame
}

func run() async {
  guard let rectText = option("--rect") else { fail("--rect X,Y,W,H is required") }
  let parts = rectText.split(separator: ",").compactMap { Double($0) }
  guard parts.count == 4 else { fail("--rect needs four numbers") }
  let rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
  let count = Int(option("--count") ?? "60") ?? 60
  let pid = option("--pid").flatMap { pid_t($0) }
  let displayID = option("--display").flatMap { UInt32($0) } ?? CGMainDisplayID()

  let content: SCShareableContent
  do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) } catch { fail("SCShareableContent: \(error)") }
  guard let display = content.displays.first(where: { $0.displayID == displayID }) else { fail("no display \(displayID)") }
  let mode = CGDisplayCopyDisplayMode(displayID)
  let hz = mode?.refreshRate ?? 60
  let scale = Double(mode?.pixelWidth ?? display.width) / Double(display.width)

  let configuration = SCStreamConfiguration()
  configuration.sourceRect = rect
  configuration.width = Int(rect.width * scale)
  configuration.height = Int(rect.height * scale)
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(hz, 60)))
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.showsCursor = false
  configuration.queueDepth = 4
  let filter = SCContentFilter(display: display, excludingWindows: [])
  let output = RegionStream()
  let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
  do {
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "keylat.frames", qos: .userInteractive))
    try await stream.startCapture()
  } catch { fail("startCapture: \(error)") }

  var samples: [[String: Any]] = []
  var misses = 0
  for index in 0..<count {
    guard let reference = waitForStill(output, quietMs: 150, timeoutMs: 3000) else { fail("no frames from the capture region") }
    // Random phase against the display's refresh.
    sleepMs(Double.random(in: 20...60))
    let keyAt = mach_absolute_time()
    postKey(kVKx, pid: pid)
    var hit: (displayTime: UInt64, arrival: UInt64, changed: Int)?
    while hit == nil && ticksToMs(mach_absolute_time() - keyAt) < 1000 {
      for entry in output.frames(after: keyAt) {
        let changed = entry.frame.changedPixels(from: reference)
        if changed > 0 {
          hit = (entry.displayTime, entry.arrival, changed)
          break
        }
      }
      if hit == nil { sleepMs(1) }
    }
    if let hit {
      samples.append([
        "index": index,
        "keyToDisplayMs": ticksToMs(hit.displayTime > keyAt ? hit.displayTime - keyAt : 0),
        "keyToFrameArrivalMs": ticksToMs(hit.arrival - keyAt),
        "changedPixels": hit.changed
      ])
    } else {
      misses += 1
    }
    postKey(kVKDelete, pid: pid)
    sleepMs(Double.random(in: 80...160))
  }
  try? await stream.stopCapture()
  printJSON([
    "method": "CGEvent \(pid == nil ? "HID tap" : "postToPid") -> ScreenCaptureKit frame displayTime, region \(rect)",
    "display": ["id": Int(displayID), "refreshHz": hz, "scale": scale],
    "frameIntervalMs": 1000 / max(hz, 60),
    "count": count,
    "misses": misses,
    "samples": samples
  ])
}

/** On-screen windows of one process, in global display points (top-left origin). */
func windowsOf(_ pid: pid_t) {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let windows: [[String: Any]] = list.compactMap { info in
    guard (info[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          (info[kCGWindowLayer as String] as? Int) == 0,
          let bounds = info[kCGWindowBounds as String] as? [String: Double] else { return nil }
    return ["id": info[kCGWindowNumber as String] ?? 0, "name": info[kCGWindowName as String] ?? "", "bounds": [bounds["X"] ?? 0, bounds["Y"] ?? 0, bounds["Width"] ?? 0, bounds["Height"] ?? 0]]
  }
  printJSON(["pid": Int(pid), "windows": windows])
}

if flag("--preflight") {
  preflight()
} else if let pid = option("--windows-of").flatMap({ pid_t($0) }) {
  windowsOf(pid)
} else if let pid = option("--activate").flatMap({ pid_t($0) }) {
  // Visible runs only: brings that one process (not every instance of its bundle) to the front.
  let ok = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows]) ?? false
  printJSON(["pid": Int(pid), "activated": ok])
} else if flag("--self-test") {
  selfTest()
} else if flag("--probe-post") {
  probePost()
} else {
  let done = DispatchSemaphore(value: 0)
  Task {
    await run()
    done.signal()
  }
  done.wait()
}
