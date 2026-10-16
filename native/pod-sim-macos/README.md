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
| `POD_SIM_FORCE_UNKNOWN_BUILD=1` | Treat the build as unknown: every capability `unsupported`, screenshots through `simctl`. For the Xcode-update drill and tests. |
| `POD_SIM_DEVICE_SET` | Use this device set instead of the default. Probes only: a running Simulator.app watches the default set and opens a window for every device booted there. The pool stays in the default set. |

The runtime builds the helper's whole environment: `PATH`, `HOME`, `TMPDIR`, `DEVELOPER_DIR`, `LANG`, `LANGUAGE` and `LC_*` from its own, the token, and the three `POD_SIM_*` settings only from its explicit options (`versionTablePath`, `deviceSet`, `forceUnknownBuild`), never inherited (`src/main/pod/sim/helper/sim-helper-env.ts`). The helper's `simctl` children get its environment without any `POD_SIM_*` key, the token included. A packaged Pod runs only `Contents/Resources/bin/pod-sim`; `POD_SIM_HELPER_BINARY` and the checkout's `.build/release/pod-sim` count only when Pod is not packaged.

## Protocol v1 (frozen for stages 2b and 3)

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

The `simctl` calls inside (`io screenshot`, `list`) end after 6 s, inside these deadlines. The deadlines are in `Fixtures/protocol-v1.json` (`deadlinesMs`), which both sides' tests compare with their constants.

`attachDisplay` keeps an existing attachment only while it still shows this boot's framebuffer: its surface answers and is the IOSurface a fresh lookup finds. Every lookup hands out a new descriptor proxy, so the surface, not the proxy, is the identity; after a reboot the old proxy answers no surface (both seen on CoreSimulator 1171.7). A device that rebooted gets a new attachment (`alreadyAttached: false`, counts from zero, a stderr line says why), and every attach drops the attachments of devices no longer booted, its own device's included (that attach answers `deviceNotBooted`, later stats `notAttached`). An attach runs outside the registry lock with a per-device marker: a second attach or a detach of the same device waits for it, other devices never do. A screenshot re-reads a cached main-display port only while the device is booted, and looks the port up again when the cached one has no surface.

`screenshot` reads the framebuffer when the self-test allows it and falls back to `xcrun simctl io <udid> screenshot --type=png --mask=ignored` when it does not or when the read fails (`fallbackReason` says why). The file is written beside the target and renamed into place. A read whose surface seed moved is retried once.

Error codes: `badFrame`, `frameTooLarge`, `helloRequired`, `tokenMismatch`, `protocolMismatch`, `unknownMethod`, `badParams`, `unsupported` (the table has no implementation for this build), `failed` (it has one and it failed here), `deviceNotFound`, `deviceNotBooted`, `notAttached`, `writeFailed`, `simctlFailed`, `timeout`, `internal`.

### The self-test report

`{protocol, helper: {version, pid}, xcode?, coreSimulator?, simulatorKit?, problem?, table: {known, entry?, source, override?, overrideError?, forcedUnknown}, capabilities: {display, screenshot, hid, ax}, deviceSet?, device?, fallbacks?}`. Each capability is `{status: ok | unsupported | failed, implementation?, checked: table | symbols | surfaceOnly | device, reason?, note?, framesSeen?}`. The order of the rules is the contract (`SelftestVerdicts`): no usable Xcode makes everything `unsupported`; then the table decides; a picked implementation whose frameworks do not load, or whose probe fails, is `failed`; a probe that passes is `ok` at the level it reached. `hid` and `ax` are `unsupported` ("not in this helper yet") until stage 3.

`display` on a device waits up to `waitMs` for a frame callback and reports `framesSeen`. It is `ok` at `device` only when frames arrived; a surface with no frame (the screen did not change while it waited) is `ok` at `surfaceOnly`, which is no proof of a live view: stages 2b and 4 treat only `device` as one. No callback at all, or frames without a surface, is `failed`.

## Runtime client

`SimHelperSupervisor` (`src/main/pod/sim/helper/`) keeps one helper for every device and answers every call with a typed result; nothing it does throws, from a call or from its restart timer. A spawn that fails (thrown or reported) is `spawnFailed`; an exit is `crashed`; a helper silent past a deadline plus the margin is killed with reason `timeout`. Each of these restarts after 250 ms doubling to 30 s, back to 250 ms once a helper lived 60 s. `tokenMismatch` and `protocolMismatch` are permanent for that build: no restart timer, and later calls (and `start()`) answer the same failure without spawning until the binary at the resolved path changes (its device, inode, size or mtime, read on each call), which is how a rebuild or an app update is noticed.

## Version table

Data, keyed by the exact `CFBundleVersion` of CoreSimulator and SimulatorKit (Xcode 26.6 and 27.0 both ship SimulatorKit "16.0", as 955.7 and 1005.2). Versions are read from the frameworks' Info.plists before anything loads, so an unknown build never runs private code. The bundled table is `Sources/PodSimKit/VersionTable/BundledVersionTable.swift`; an override file has the same shape and its rows replace bundled rows for the same build pair:

```json
{"schema": 1, "builds": [{"name": "Xcode 27.0 (27A266a)", "coreSimulator": "1171.7", "simulatorKit": "1005.2",
  "capabilities": {"display": "screenCallbacks", "screenshot": "surface"}, "verified": "..."}]}
```

A capability left out of a row is unsupported for that build (that is how a row blocks one). A name this binary does not implement is unsupported, never attempted. Stage 3 adds its implementations (`hid`, `ax`) to `SelftestRunner.implemented` and to the rows it verified.

| Build pair | Row | Seen |
|---|---|---|
| CoreSimulator 1171.7, SimulatorKit 1005.2 | Xcode 27.0 (27A266a): `display` = `screenCallbacks`, `screenshot` = `surface` | macOS 27.0.1, iOS 26.5, stage 0 and this stage |
| CoreSimulator 1171.7, SimulatorKit 955.7 | none: Xcode 26.6 (17F113) reports unknown | not verified |

## Private symbols relied on

All seen in CoreSimulator 1171.7 and SimulatorKit 1005.2 (Xcode 27.0, 27A266a) by the stage 0 spike and this helper's device self-test.

- CoreSimulator: `+[SimServiceContext sharedServiceContextForDeveloperDir:error:]`, `-defaultDeviceSetWithError:`, `-deviceSetWithPath:error:` (only with `POD_SIM_DEVICE_SET`); `SimDeviceSet devices`; `SimDevice` `UDID`, `name`, `stateString`, `deviceType`, `io`; `SimDeviceType mainScreenSize`; `SimDeviceIOClient` `updateIOPorts`, `deviceIOPorts`.
- IO ports (remote proxies, every call guarded): port `portIdentifier` (`com.apple.framebuffer.display`), `descriptor`; descriptor `framebufferSurface`, `state.displayClass` (sent as a message: KVC on the proxy raises), `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:` (surfaces callback takes two arguments, properties one), `unregisterScreenCallbacksWithUUID:`.
- Main display: an iPhone 16 Pro has three framebuffer ports (display classes 1, 0, 1); class 0 carries the 1206x2622 surface. The helper picks class 0, then the surface the size of the screen, then the largest.
- Locations: CoreSimulator at `/Library/Developer/PrivateFrameworks/CoreSimulator.framework` (the path Xcode 27's own `simctl` wrapper reads); SimulatorKit at `<Xcode>/Contents/SharedFrameworks` (Xcode 27) or `<developer dir>/Library/PrivateFrameworks` (Xcode 26 and older).

Every call into these goes through `PodSimObjCTry` (`Sources/CPodSimObjC`), so an Objective-C exception from a moved selector becomes a `failed` verdict or error, never a crash.

Third-party sources these shapes were read from are in `THIRD_PARTY_NOTICES.md`.
