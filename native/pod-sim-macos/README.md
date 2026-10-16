# pod-sim

The only Pod process that loads CoreSimulator and SimulatorKit. Pod's runtime (`src/main/pod/sim/helper/`) starts it, talks to it over stdio and restarts it when it dies; PodNative and the runtime load no private framework. Everything private is resolved at run time (`NSClassFromString`, selectors, `dlsym`): the binary links none of it, and loads it only for a build its version table knows.

## Build

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer native/pod-sim-macos/scripts/build.sh [--single-arch]
swift test --package-path native/pod-sim-macos
```

The script writes `.build/release/pod-sim` (universal by default) and signs it as Pod's packaging signs a new helper: hardened runtime, the empty `product/entitlements/none.plist`, Developer ID from the login keychain (ad hoc when there is none; `POD_SIM_SIGN_IDENTITY` overrides). Identifier `codes.pod.sim`. Packaging into Pod.app is stage 2b.

## Command line

```sh
pod-sim                                   # serve protocol v1 on stdio; needs POD_SIM_TOKEN
pod-sim --selftest [--json] [--udid <udid>] [--wait-ms <n>]
pod-sim --version
```

`--selftest` exits 0 whenever it produced a report, whatever the report says; 64 is a usage error.

| Environment | Effect |
|---|---|
| `DEVELOPER_DIR` | The Xcode to use; else `xcode-select -p`. Never a fixed path. An `.app` path is accepted. |
| `POD_SIM_TOKEN` | This spawn's token; `hello` must carry it. Set by the runtime. |
| `POD_SIM_VERSION_TABLE` | A version-table file overlaid on the bundled one (a fix without a release). An unreadable file is reported in `table.overrideError` and ignored. |
| `POD_SIM_FORCE_UNKNOWN_BUILD=1` | Treat the build as unknown: every capability `unsupported`, screenshots through `simctl`, `hid` and `ax` refused with the reason. For the Xcode-update drill and tests. |
| `POD_SIM_DEVICE_SET` | Use this device set instead of the default. Probes only: a running Simulator.app watches the default set and opens a window for every device booted there. The pool stays in the default set. |

The runtime builds the helper's whole environment: `PATH`, `HOME`, `TMPDIR`, `DEVELOPER_DIR`, `LANG`, `LANGUAGE` and `LC_*` from its own, the token, and the three `POD_SIM_*` settings only from its explicit options (`versionTablePath`, `deviceSet`, `forceUnknownBuild`), never inherited (`src/main/pod/sim/helper/sim-helper-env.ts`). The helper's `simctl` children get its environment without any `POD_SIM_*` key, the token included. A packaged Pod runs only `Contents/Resources/bin/pod-sim`; `POD_SIM_HELPER_BINARY` and the checkout's `.build/release/pod-sim` count only when Pod is not packaged.

## Protocol v1 (frozen for stages 2b and 3; with `hid` and `ax`, frozen for stages 4, 7 and 8)

Runtime and helper ship in one bundle, so there is one protocol version and no compatibility window. `Fixtures/protocol-v1.json` holds the constants, the exchanges and example results; the Swift tests and the runtime client's tests both decode it.

- **Transport:** the helper's stdin and stdout. Stderr is diagnostics. At start the helper keeps a private copy of stdout for frames and points fd 1 at stderr, so a framework that prints cannot corrupt the stream. When stdin closes, the helper detaches every display and exits 0.
- **Framing:** one UTF-8 JSON object per line, `\n` terminated, at most 1,048,576 bytes before the newline, both directions. A longer request line is dropped as it arrives (never buffered) and answered with `frameTooLarge`; a reply that would be longer goes out as `{"id": n, "error": {"code": "frameTooLarge"}}` instead. Blank lines are skipped, a trailing CR is dropped.
- **Request:** `{"id": <non-negative integer>, "method": "<name>", "params": {...}}`; `params` may be absent.
- **Reply:** `{"id": n, "result": {...}}` or `{"id": n | null, "error": {"code": "<code>", "message": "..."}}`. `id` is null only when the helper could not read the request's id. Replies can arrive out of order; match by id.
- **Handshake:** the first accepted request is `hello {"token": "<POD_SIM_TOKEN>", "protocol": 1}`. Anything before it gets `helloRequired`; a wrong token gets `tokenMismatch` and the session stays locked; another protocol gets `protocolMismatch`. The token binds the session to the spawn that set the environment: with stdio no other process can reach the helper, and the token makes a helper that did not get this spawn's environment (a wrapper, the wrong binary) refuse instead of being trusted.
- **Deadlines:** each method has one, below. Past it the helper answers `timeout` itself and goes on serving; the work's late result is dropped. The runtime gives each call its deadline plus 2,000 ms in flight, counted from when the helper is ready (waiting for a helper that is starting or restarting does not count), and replaces the helper only when it stays silent that long: restart reason `timeout`. One device's slow call therefore costs that call, not every device's live view. `hello` is answered at once from the start-up self-test; the runtime allows 15 s for a spawn to reach it.
- **Events:** none in v1. A later stage that adds them uses `{"event": "<name>", "params": {...}}` with no id.

| Method | Deadline | Params | Result |
|---|---|---|---|
| `hello` | answered at once | `token`, `protocol` | the start-up self-test report (below), checked at `symbols` level |
| `selftest` | 20,000 ms | `udid?`, `waitMs?` (100 to 10000, default 1500) | the self-test report, with device checks when `udid` is a booted device |
| `attachDisplay` | 5,000 ms | `udid` | `{udid, surface?: {width, height, id}, alreadyAttached}`; registers screen callbacks on the main display |
| `displayStats` | 2,000 ms | `udid` | `{udid, seconds, frameCallbacks, surfaceCallbacks, seedChanges}` since attach |
| `detachDisplay` | 5,000 ms | `udid` | the same counts, final |
| `screenshot` | 8,000 ms | `udid`, `path` (absolute, directory must exist), `format?` (`png`, `jpeg`), `scale?` (0 to 1], `quality?` (0 to 1] | `{path, format, width, height, bytes, source: "surface" \| "simctl", ms, fallbackReason?}` |
| `hid` | 15,000 ms | `udid`, `action` (below), `waitForFrameMs?` (1 to 2000) | `{udid, kind, ms, via?: "hid" \| "paste", typed?, frameAfterMs?, degraded?, alert?: "pastePermission"}` |
| `ax` | 5,000 ms | `udid`, `maxNodes?` (1 to 500, default 60), `filter?` (1 to 256 characters), `all?`, `hitTest?` (default true) | `{udid, screen: {width, height, scale}, app?: {pid}, nodes, total, shown, omitted, notVisible, alertSuspected, fingerprint, ms, transport: "bridge" \| "coreSimulator"}` |

The `simctl` calls inside (`io screenshot`, `list`) end after 6 s, inside these deadlines. The deadlines are in `Fixtures/protocol-v1.json` (`deadlinesMs`), which both sides' tests compare with their constants.

`attachDisplay` keeps an existing attachment only while it still shows this boot's framebuffer: its surface answers and is the IOSurface a fresh lookup finds. Every lookup hands out a new descriptor proxy, so the surface, not the proxy, is the identity; after a reboot the old proxy answers no surface (both seen on CoreSimulator 1171.7). A device that rebooted gets a new attachment (`alreadyAttached: false`, counts from zero, a stderr line says why), and every attach drops the attachments of devices no longer booted, its own device's included (that attach answers `deviceNotBooted`, later stats `notAttached`). An attach runs outside the registry lock with a per-device marker: a second attach or a detach of the same device waits for it, other devices never do. A screenshot re-reads a cached main-display port only while the device is booted, and looks the port up again when the cached one has no surface.

`screenshot` reads the framebuffer when the self-test allows it and falls back to `xcrun simctl io <udid> screenshot --type=png --mask=ignored` when it does not or when the read fails (`fallbackReason` says why). The file is written beside the target and renamed into place. A read whose surface seed moved is retried once.

### `hid`: touch, keys, buttons

Coordinates are device points with the origin top left, the space `ax` frames are in; a point off the screen is `badParams`, never clamped. Every event goes to the device's `dtuhidd` (`com.apple.coredevice.feature.remote.hid.digitizer`) over one XPC connection per device, made the way idb v1.7.2 makes it and kept until it breaks; a connection whose liveness barrier does not come back within 4 s is refused (the daemon may still be starting) and the next call connects again. Calls for one device run in order on that device's queue; devices never wait on each other. After the last event the helper sends a barrier and answers only once `dtuhidd` has handled everything; a barrier that does not come back in 2 s fails the call and drops the connection.

| `action.kind` | Fields (defaults) | What the device gets |
|---|---|---|
| `tap` | `x`, `y`, `holdMs?` (60; 1 to 5000) | one contact down, held, up |
| `longPress` | `x`, `y`, `durationMs?` (1000; 300 to 5000) | the same, held longer |
| `swipe` | `from`, `to`, `durationMs?` (300; 50 to 5000), `edge?` (`left`, `right`, `top`, `bottom`) | a contact moving every 16 ms, held at the end before it lifts; `edge` marks it as starting on that screen edge (iOS's back and home gestures) |
| `drag` | `from`, `to`, `pressMs?` (600; 0 to 3000), `durationMs?` (500), `releaseMs?` (200; 0 to 2000) | press and hold, move, hold, lift: what a drag-and-drop needs |
| `pinch` | `centre`, `fromSpan`, `toSpan` (1 to 4000 points between the fingers), `durationMs?` (400), `angle?` (degrees, 0 side by side) | two contacts moving apart or together |
| `touch` | `phase` (`down`, `move`, `up`), `points` (1 or 2), `edge?` | one raw phase, for a person's pointer (stage 8) |
| `text` | `text`, `via?` (`auto`, `keys`, `paste`) | see below |
| `key` | `key` (a name from the contract's `SIM_KEYS`, or one printable ASCII character) or `usage` (HID keyboard page), `modifiers?` (`shift`, `control`, `option`, `command`), `phase?` (`press`, `down`, `up`) | the key with its modifiers held around it; a character that needs shift on a US layout gets it |
| `button` | `button` (`home`, `lock`, `siri`, `volumeUp`, `volumeDown`), `holdMs?` (100) | the hardware button |

No action may plan more than 10 s of events. `waitForFrameMs` reports `frameAfterMs`, the time from the first event to the first frame the device draws after it (absent when none comes in time): the input-to-damage latency stage 0 measured.

**Text.** `auto` types printable ASCII (plus newline and tab) of at most 250 characters as US-layout key presses, 12 ms apart. Anything else goes through the device's pasteboard (`xcrun simctl pbcopy`, run with `LC_ALL=en_US.UTF-8` because it decodes stdin in the locale's encoding and a Pod started from Finder has no locale: "zażółć" landed as MacRoman mojibake without it) and Cmd+V, up to 4,096 characters; `keys` refuses text with a character that has no US key and names it. A paste into an app that has not been granted the pasteboard makes iOS ask "Allow Paste": the helper watches for 600 ms whether SpringBoard takes the screen and then answers `alert: "pastePermission"`; the prompt's buttons are in `ax`, and the text lands once "Allow Paste" is tapped. `xcrun simctl privacy <udid> grant pasteboard <bundle id>` (not in `simctl`'s list, but passed through to `kTCCServicePasteboard`; seen on iOS 26.5) grants it ahead, after which a paste needs no tap. Both paths typed "zażółć gęślą jaźń" exactly (2026-10-16).

### `ax`: the accessibility snapshot

The frontmost application's tree (SpringBoard on the home screen and while a system prompt is up), read through macOS's AccessibilityPlatformTranslation the way idb v1.7.2 reads it: one batched attribute request per element, at most 2,000 elements and 80 levels, within a 2.5 s walk budget. The translator is single-threaded, so walks of different devices take turns; a device whose accessibility server hangs costs others at most that budget. Requests go straight to the device's `com.apple.CoreSimulator.accessibility` service (`transport: "bridge"`), or through `-[SimDevice sendAccessibilityRequestAsync:...]` when that service cannot be reached (`coreSimulator`).

Nodes are the contract's `SimNode`, field for field: `index` (walk order, stable across `filter`), `role`, `label` (the element's description), `value`, `id` (accessibility identifier, the test id), `centre`, `frame`, `visible`, `enabled?`, `selected?`, `focused?`; texts are cut to 120 characters with "…". The application element itself is not a node. `centre` is the middle of the part of the frame that is on screen: a tap there lands on the element even when it is cut by the screen edge. `visible` is false for a hidden element, one without area, one off screen, and, with `hitTest`, one whose centre answers with another element of the same app (covered by a sheet or the keyboard); a hit on its own descendant or ancestor counts as itself, and content another process draws inside the app (web content, widgets) cannot be told apart, so it stays visible. Without `all`, only visible nodes are listed and the rest are counted in `notVisible`. `filter` matches label, value or id, ignoring case and diacritics (ł has no decomposition: "lodz" does not find "Łódź"). `total` counts what is eligible, `shown` what is listed (at most `maxNodes`), `omitted` the rest: the contract's "+N more".

`alertSuspected` is true when the tree collapsed to the application element: system UI no tree shows (the keyboard's first-use tip, AutoFill's "Save Password?") may cover the app, and a screenshot is the only way to see it. An app that is still launching collapses the same way for a moment. Web content in Safari and in web views is not in the tree.

`fingerprint` (16 hex characters) changes only when what is on screen changes: it covers role, label, id, value, the frame rounded to whole points, hidden, enabled and selected, and leaves out focus and the values of progress and busy indicators and of elements that say they update frequently (a caret, a spinner). Stage 2b's settle compares two.

### Public fallback seam

When the table gives `hid` or `ax` no private implementation (an unknown build, a row without them, an unlisted macOS for `ax`), the call goes to a public fallback by UDID before any device lookup, since CoreSimulator is then not loaded. None ships: the call answers `unsupported` with the table's reason and "no public input fallback in this helper (an XCTest driver is owed)". A fallback that acts answers in place of the private path with `degraded` set.

Error codes: `badFrame`, `frameTooLarge`, `helloRequired`, `tokenMismatch`, `protocolMismatch`, `unknownMethod`, `badParams`, `unsupported` (the table has no implementation for this build), `failed` (it has one and it failed here), `deviceNotFound`, `deviceNotBooted`, `notAttached`, `writeFailed`, `simctlFailed`, `timeout`, `internal`.

### The self-test report

`{protocol, helper: {version, pid}, xcode?, coreSimulator?, simulatorKit?, macOS?: {version, build}, accessibilityTranslation?, problem?, table: {known, entry?, source, override?, overrideError?, forcedUnknown}, capabilities: {display, screenshot, hid, ax}, deviceSet?, device?, fallbacks?}`. Each capability is `{status: ok | unsupported | failed, implementation?, checked: table | symbols | surfaceOnly | device, reason?, note?, framesSeen?}`. The order of the rules is the contract (`SelftestVerdicts`): no usable Xcode makes everything `unsupported`; then the table decides; a picked implementation whose frameworks do not load, or whose probe fails, is `failed`; a probe that passes is `ok` at the level it reached. On a device, `hid` connects to `dtuhidd` and waits for a barrier; `ax` reads the frontmost application's root.

`display` on a device waits up to `waitMs` for a frame callback and reports `framesSeen`. It is `ok` at `device` only when frames arrived; a surface with no frame (the screen did not change while it waited) is `ok` at `surfaceOnly`, which is no proof of a live view: stages 2b and 4 treat only `device` as one. No callback at all, or frames without a surface, is `failed`.

## Runtime client

`SimHelperSupervisor` (`src/main/pod/sim/helper/`) keeps one helper for every device and answers every call with a typed result; nothing it does throws, from a call or from its restart timer. A spawn that fails (thrown or reported) is `spawnFailed`; an exit is `crashed`; a helper silent past a deadline plus the margin is killed with reason `timeout`. Each of these restarts after 250 ms doubling to 30 s, back to 250 ms once a helper lived 60 s. `tokenMismatch` and `protocolMismatch` are permanent for that build: no restart timer, and later calls (and `start()`) answer the same failure without spawning until the binary at the resolved path changes (its device, inode, size or mtime, read on each call), which is how a rebuild or an app update is noticed.

## Version table

Data, keyed by the exact `CFBundleVersion` of CoreSimulator and SimulatorKit (Xcode 26.6 and 27.0 both ship SimulatorKit "16.0", as 955.7 and 1005.2). Versions are read from the frameworks' Info.plists before anything loads, so an unknown build never runs private code. The bundled table is `Sources/PodSimKit/VersionTable/BundledVersionTable.swift`; an override file has the same shape and its rows replace bundled rows for the same build pair:

```json
{"schema": 1, "builds": [{"name": "Xcode 27.0 (27A266a)", "coreSimulator": "1171.7", "simulatorKit": "1005.2",
  "capabilities": {"display": "screenCallbacks", "screenshot": "surface"}, "verified": "..."}]}
```

A capability left out of a row is unsupported for that build (that is how a row blocks one). A name this binary does not implement is unsupported, never attempted.

`ax` has a second key. AccessibilityPlatformTranslation ships with macOS, not with Xcode, so a row's `ax` counts only where the running macOS build is listed under `accessibility` with the same implementation; otherwise `ax` is `unsupported` ("macOS <build> is not in the version table for ax") while the rest of the row stands. An override's `accessibility` entries replace bundled ones for the same macOS build:

```json
{"schema": 1, "builds": [],
 "accessibility": [{"name": "macOS 27.0.1 (26A434)", "macOS": "26A434", "ax": "translatorWalk", "verified": "..."}]}
```

| Build pair | Row | Seen |
|---|---|---|
| CoreSimulator 1171.7, SimulatorKit 1005.2 | Xcode 27.0 (27A266a): `display` = `screenCallbacks`, `screenshot` = `surface`, `hid` = `dtuhid`, `ax` = `translatorWalk` | macOS 27.0.1, iOS 26.5, stages 0, 2a and 3 |
| macOS 26A434 (accessibility) | macOS 27.0.1: `ax` = `translatorWalk` | AccessibilityPlatformTranslation 1.0 (587), stages 0 and 3 |
| CoreSimulator 1171.7, SimulatorKit 955.7 | none: Xcode 26.6 (17F113) reports unknown | not verified |

## Private symbols relied on

All seen in CoreSimulator 1171.7 and SimulatorKit 1005.2 (Xcode 27.0, 27A266a) by the stage 0 spike and this helper's device self-test.

- CoreSimulator: `+[SimServiceContext sharedServiceContextForDeveloperDir:error:]`, `-defaultDeviceSetWithError:`, `-deviceSetWithPath:error:` (only with `POD_SIM_DEVICE_SET`); `SimDeviceSet devices`; `SimDevice` `UDID`, `name`, `stateString`, `deviceType`, `io`; `SimDeviceType mainScreenSize`; `SimDeviceIOClient` `updateIOPorts`, `deviceIOPorts`.
- IO ports (remote proxies, every call guarded): port `portIdentifier` (`com.apple.framebuffer.display`), `descriptor`; descriptor `framebufferSurface`, `state.displayClass` (sent as a message: KVC on the proxy raises), `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:` (surfaces callback takes two arguments, properties one), `unregisterScreenCallbacksWithUUID:`.
- Main display: an iPhone 16 Pro has three framebuffer ports (display classes 1, 0, 1); class 0 carries the 1206x2622 surface. The helper picks class 0, then the surface the size of the screen, then the largest.
- Input (`hid`): `-[SimDevice lookup:error:]` (a service's Mach port in the device); libxpc's `xpc_endpoint_create_mach_port_4sim`, `xpc_connection_create_from_endpoint`, `xpc_connection_enable_sim2host_4sim` (`dlsym`); `dtuhidd`'s messages `IndigoDigitizerEvent` (`pointOne`, `pointTwo`, `eventType` 0 down, 1 move, 2 up, `edge`, `target`, points as 0 to 1 of the screen), `IndigoKeyboardButtonEvent` (`usageCode`, `state` 1 down, 2 up; usage 0 as a barrier), `IndigoButtonEvent` (`usagePage`, `usageCode`, `state`), each in `{messageType, isBarrier, featureIdentifier, payload}`.
- Accessibility (`ax`), AccessibilityPlatformTranslation 1.0 (587) on macOS 27.0.1: `AXPTranslator` `sharedInstance`, `bridgeTokenDelegate`, `supportsDelegateTokens`, `accessibilityEnabled`, `frontmostApplicationWithDisplayId:bridgeDelegateToken:`, `macPlatformElementFromTranslation:`, `objectAtPoint:displayId:bridgeDelegateToken:`; `AXPTranslationObject` `bridgeDelegateToken`, `objectID`, `pid`; `AXPMacPlatformElement` `translation`, `accessibilityMultipleAttributes:` (`AXFrame`, `AXRole`, `AXDescription`, `AXValue`, `AXIdentifier`, `AXEnabled`, `AXFocused`, `AXHidden`, `AXTraits`, `AXChildren`); `+[AXPTranslatorResponse emptyResponse]`; the delegate callbacks `accessibilityTranslationDelegateBridgeCallbackWithToken:`, `accessibilityTranslationConvertPlatformFrameToSystem:withToken:`, `accessibilityTranslationRootParentWithToken:`; CoreSimulator's `-[SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:]`; the device's `com.apple.CoreSimulator.accessibility` service with `{SimAccessibility_PayloadClassName: "AXPTranslatorRequest", SimAccessibility_Payload: {translatorRequest: <keyed archive>}}`, answered by `AXPTranslatorResponse` under `translatorResponse`. UIKit trait bits read: selected 1<<3, not enabled 1<<8, updates frequently 1<<9.
- Locations: CoreSimulator at `/Library/Developer/PrivateFrameworks/CoreSimulator.framework` (the path Xcode 27's own `simctl` wrapper reads); SimulatorKit at `<Xcode>/Contents/SharedFrameworks` (Xcode 27) or `<developer dir>/Library/PrivateFrameworks` (Xcode 26 and older).

Every call into these goes through `PodSimObjCTry` (`Sources/CPodSimObjC`), so an Objective-C exception from a moved selector becomes a `failed` verdict or error, never a crash. The self-test checks each picked implementation's selectors and symbols before it calls one (`missingSymbols`).

Third-party sources these shapes were read from are in `THIRD_PARTY_NOTICES.md`.
