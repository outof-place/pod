// Fork-only (Pod): the pod-sim helper's protocol v1 as the runtime reads it. The helper
// (native/pod-sim-macos) is the only Pod process that loads CoreSimulator and SimulatorKit; the two
// ship in one bundle, so there is one version and no compatibility window. Wire: one JSON object per
// line on the helper's stdio, at most SIM_HELPER_MAX_FRAME_BYTES before the newline. The shared
// fixture native/pod-sim-macos/Fixtures/protocol-v1.json is decoded by both sides' tests.
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { SimNode } from '../../../../shared/pod-sim/sim-results'
import {
  SimHelperAttachResult,
  SimHelperDisplayStats,
  SimHelperScreenshot,
  SimHelperSettleResult,
  SimHelperStartStreamResult,
  SimHelperStreamStats
} from './sim-helper-display-results'
import { SimHelperXcode } from './sim-helper-xcode'

export const SIM_HELPER_PROTOCOL_VERSION = 1
export const SIM_HELPER_MAX_FRAME_BYTES = 1_048_576
export const SIM_HELPER_TOKEN_ENV = 'POD_SIM_TOKEN'
/** A version-table file the helper overlays on its bundled table (rows replace rows for the same builds). */
export const SIM_HELPER_VERSION_TABLE_ENV = 'POD_SIM_VERSION_TABLE'
/** `1` makes the helper treat its build as unknown: the Xcode-update drill. */
export const SIM_HELPER_FORCE_UNKNOWN_ENV = 'POD_SIM_FORCE_UNKNOWN_BUILD'
/** A device set other than the default, so a probe's devices stay out of a running Simulator.app. */
export const SIM_HELPER_DEVICE_SET_ENV = 'POD_SIM_DEVICE_SET'

export const SIM_HELPER_ERROR_CODES = [
  'badFrame',
  'frameTooLarge',
  'helloRequired',
  'tokenMismatch',
  'protocolMismatch',
  'unknownMethod',
  'badParams',
  // The version table has no implementation of the capability for this build.
  'unsupported',
  // The table picked one and it failed here (a moved symbol, no surface).
  'failed',
  'deviceNotFound',
  'deviceNotBooted',
  'notAttached',
  'writeFailed',
  'simctlFailed',
  // Past the method's deadline. For hid the work may still have reached the device: read state
  // (ax, a screenshot) before retrying. A hid still waiting in its device's queue was never sent.
  'timeout',
  // The device's hid queue is full (16 calls running or waiting); nothing was sent. Coalesce touch
  // moves, and resend a touch up, which a dropped one would leave the finger down.
  'busy',
  // The hid call waited behind one stuck in a private call; the device's queue and input connection
  // were reset and this call was never sent. Send it again (an inputWedged event says more).
  'wedged',
  'internal'
] as const
export type SimHelperErrorCode = (typeof SIM_HELPER_ERROR_CODES)[number]

export const SIM_HELPER_CAPABILITIES = ['display', 'screenshot', 'hid', 'ax'] as const
export type SimHelperCapability = (typeof SIM_HELPER_CAPABILITIES)[number]

const Verdict = z.enum(['ok', 'unsupported', 'failed'])

/**
 * How far a check got: the table alone, frameworks and symbols, a booted device's surface without a
 * frame (the screen did not change while it waited), or a booted device end to end. `display` ok at
 * `device` means frames arrived; at `surfaceOnly` it is no proof of a live view.
 */
export const SIM_HELPER_CHECK_LEVELS = ['table', 'symbols', 'surfaceOnly', 'device'] as const

const CapabilityReport = z.object({
  status: Verdict,
  implementation: z.string().optional(),
  checked: z.enum(SIM_HELPER_CHECK_LEVELS),
  reason: z.string().optional(),
  note: z.string().optional(),
  // display, checked on a device: frame callbacks seen while the self-test waited.
  framesSeen: z.number().int().optional()
})
export type SimHelperCapabilityReport = z.infer<typeof CapabilityReport>

const Framework = z.object({ path: z.string(), version: z.string(), build: z.string() })

export const SimHelperReport = z.object({
  protocol: z.number().int(),
  helper: z.object({ version: z.string(), pid: z.number().int() }),
  xcode: SimHelperXcode.optional(),
  coreSimulator: Framework.optional(),
  simulatorKit: Framework.optional(),
  // The running macOS and its AccessibilityPlatformTranslation, which key `ax` (not Xcode).
  macOS: z.object({ version: z.string(), build: z.string() }).optional(),
  accessibilityTranslation: Framework.optional(),
  // No usable Xcode, CoreSimulator or SimulatorKit.
  problem: z.string().optional(),
  table: z.object({
    known: z.boolean(),
    entry: z.string().optional(),
    source: z.enum(['bundled', 'override']),
    override: z.string().optional(),
    overrideError: z.string().optional(),
    forcedUnknown: z.boolean()
  }),
  capabilities: z.object({
    display: CapabilityReport,
    screenshot: CapabilityReport,
    hid: CapabilityReport,
    ax: CapabilityReport
  }),
  // POD_SIM_DEVICE_SET: the device set the helper works in; the pool's own set (~/.pod/sim) once
  // stage 7 starts the helper with it, the default set until then.
  deviceSet: z.string().optional(),
  device: z
    .object({
      udid: z.string(),
      name: z.string().optional(),
      state: z.string().optional(),
      problem: z.string().optional()
    })
    .optional(),
  fallbacks: z
    .object({
      screenshot: z.object({
        via: z.string(),
        status: Verdict,
        ms: z.number().int().optional(),
        reason: z.string().optional()
      })
    })
    .optional()
})
/** `hello`'s result (the start-up self-test) and `selftest`'s. */
export type SimHelperReport = z.infer<typeof SimHelperReport>

const Udid = z.object({ udid: z.string() })

// Device points, origin top-left: the accessibility frames' space. The helper refuses points off
// the screen (badParams) instead of clamping them.
const DevicePoint = z.object({ x: z.number(), y: z.number() })
const Edge = z.enum(['left', 'right', 'top', 'bottom'])

/**
 * What `hid` does. Gestures are timed by the helper (defaults: tap holdMs 60, longPress durationMs
 * 1000, swipe durationMs 300, drag pressMs 600 / durationMs 500 / releaseMs 200, pinch durationMs
 * 400, button holdMs 100); `touch` is one raw contact phase for a person's pointer (stage 8). Text
 * goes as US keys when it is printable ASCII (plus newline and tab) of at most 250 characters, else
 * through the device pasteboard and Cmd+V; `via` forces one. No action plans over 8 s. A device's
 * calls run one at a time in the order they arrive.
 */
export const SimHelperHidAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    x: z.number(),
    y: z.number(),
    holdMs: z.number().int().optional()
  }),
  z.object({
    kind: z.literal('longPress'),
    x: z.number(),
    y: z.number(),
    durationMs: z.number().int().optional()
  }),
  z.object({
    kind: z.literal('swipe'),
    from: DevicePoint,
    to: DevicePoint,
    durationMs: z.number().int().optional(),
    // Flags every contact as starting on that edge: iOS reads a system gesture (back, home).
    edge: Edge.optional()
  }),
  z.object({
    kind: z.literal('drag'),
    from: DevicePoint,
    to: DevicePoint,
    pressMs: z.number().int().optional(),
    durationMs: z.number().int().optional(),
    releaseMs: z.number().int().optional()
  }),
  z.object({
    kind: z.literal('pinch'),
    centre: DevicePoint,
    fromSpan: z.number(),
    toSpan: z.number(),
    durationMs: z.number().int().optional(),
    // Degrees; 0 puts the two fingers side by side.
    angle: z.number().optional()
  }),
  z.object({
    kind: z.literal('touch'),
    phase: z.enum(['down', 'move', 'up']),
    points: z.array(DevicePoint).min(1).max(2),
    edge: Edge.optional()
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string().min(1),
    via: z.enum(['auto', 'keys', 'paste']).optional()
  }),
  z.object({
    kind: z.literal('key'),
    // A name from SIM_KEYS or one printable ASCII character; or a raw HID keyboard usage (page 7).
    key: z.string().optional(),
    usage: z.number().int().optional(),
    modifiers: z.array(z.enum(['shift', 'control', 'option', 'command'])).optional(),
    phase: z.enum(['press', 'down', 'up']).optional()
  }),
  z.object({
    kind: z.literal('button'),
    button: z.enum(['home', 'lock', 'siri', 'volumeUp', 'volumeDown']),
    holdMs: z.number().int().optional()
  })
])
export type SimHelperHidAction = z.infer<typeof SimHelperHidAction>

export const SimHelperHidResult = z.object({
  udid: z.string(),
  kind: z.string(),
  // Time spent sending, waits included.
  ms: z.number().int(),
  via: z.enum(['hid', 'paste']).optional(),
  typed: z.number().int().optional(),
  // With waitForFrameMs: the first frame after the first event; absent when none came in time.
  frameAfterMs: z.number().optional(),
  // A public fallback did the work instead of the private path: the version table's reason (none ships yet).
  degraded: z.string().optional(),
  // After a paste, iOS asks whether the app may paste (no `simctl privacy <udid> grant pasteboard
  // <bundle>` for it): the text lands once "Allow Paste", which `ax` lists, is tapped.
  alert: z.literal('pastePermission').optional()
})

/**
 * `ax`'s answer: the frozen contract's `state` nodes (SimNode, field for field) and counts. `index`
 * counts the whole walk, so it survives a filter; `centre` is the middle of a node's on-screen part;
 * `visible` is on screen, not hidden and, when hit-tested, not covered. `fingerprint` changes only
 * when what is on screen does (not for spinner values, focus or sub-point jitter): settle compares two.
 */
export const SimHelperAxResult = z.object({
  udid: z.string(),
  screen: z.object({
    // Points in the app's orientation.
    width: z.number(),
    height: z.number(),
    scale: z.number(),
    // From the application element's size; absent when it fits neither way (a Slide Over window).
    // hid refuses taps and gestures while a device's latest snapshot says landscape.
    orientation: z.enum(['portrait', 'landscape']).optional()
  }),
  app: z.object({ pid: z.number().int() }).optional(),
  nodes: z.array(SimNode),
  total: z.number().int(),
  shown: z.number().int(),
  omitted: z.number().int(),
  // Matching nodes left out for being off screen, hidden or covered (0 with `all`).
  notVisible: z.number().int(),
  // The tree collapsed to the application element: system UI no tree shows may cover the app.
  alertSuspected: z.boolean(),
  fingerprint: z.string(),
  ms: z.number().int(),
  // `fallback`: a public driver read the tree (with `degraded`); none ships yet.
  transport: z.enum(['bridge', 'coreSimulator', 'fallback']),
  // A public fallback read the tree instead of the translator: the version table's reason.
  degraded: z.string().optional(),
  // How the tree was read: `cache` (the last read, nothing on screen changed since), `parallel`
  // (read now, many requests at once) or `translator` (read now, one request at a time). Absent
  // from a public fallback and from helpers before stage 3b.
  basis: z.enum(['cache', 'parallel', 'translator']).optional(),
  // Why a helper that reads in parallel read this one through the translator.
  fallbackReason: z.string().optional()
})
export type SimHelperAxResult = z.infer<typeof SimHelperAxResult>

/** Each method's params and result; params are what the runtime sends. */
/**
 * A live view's nonce: 64 random bits as 16 lowercase hex digits (a JSON number cannot carry 64
 * bits), never all zero. pod-sim puts it in every frame-wire message (pod_sim_frame.h).
 */
export const SimHelperStreamNonce = z.string().regex(/^(?!0{16})[0-9a-f]{16}$/)

export function simStreamNonce(): string {
  for (;;) {
    const nonce = randomBytes(8).toString('hex')
    if (nonce !== '0000000000000000') {
      return nonce
    }
  }
}

export const SIM_HELPER_METHODS = {
  selftest: {
    params: z.object({ udid: z.string().optional(), waitMs: z.number().int().optional() }),
    result: SimHelperReport
  },
  attachDisplay: { params: Udid, result: SimHelperAttachResult },
  displayStats: { params: Udid, result: SimHelperDisplayStats },
  detachDisplay: { params: Udid, result: SimHelperDisplayStats },
  screenshot: {
    params: z.object({
      udid: z.string(),
      path: z.string(),
      format: z.enum(['png', 'jpeg']).optional(),
      scale: z.number().optional(),
      quality: z.number().optional()
    }),
    result: SimHelperScreenshot
  },
  hid: {
    params: z.object({
      udid: z.string(),
      action: SimHelperHidAction,
      // 1 to 2000: report the first frame after the first event (input-to-damage), waiting at most
      // this long after it. Refused with text that goes in by paste.
      waitForFrameMs: z.number().int().optional()
    }),
    result: SimHelperHidResult
  },
  ax: {
    params: z.object({
      udid: z.string(),
      // 1 to 500, default 60 (the contract's state budget); the rest is counted in `omitted`.
      maxNodes: z.number().int().optional(),
      // Case- and diacritic-insensitive substring of label, value or id.
      filter: z.string().optional(),
      // Off-screen, hidden and covered nodes too.
      all: z.boolean().optional(),
      // Hit-test each on-screen node so a covered one is not offered (default true).
      hitTest: z.boolean().optional(),
      // Read the device now even when the last read still matches the screen (default false).
      fresh: z.boolean().optional()
    }),
    result: SimHelperAxResult
  },
  startStream: {
    params: z.object({
      udid: z.string(),
      // The viewer's launchd rendezvous name, checked in before this call:
      // codes.pod.native(.dev)?.sim.<32 hex> (src/main/pod/sim-pane/pod-sim-pane-protocol.ts).
      service: z.string(),
      // The ui-host simAttach token, 1 to 2^31 - 1, carried in every message.
      token: z.number().int(),
      // simStreamNonce(), given to the viewer with the rendezvous too: it keeps only this stream's
      // messages. The same view started again (a reboot, a helper restart) keeps its nonce.
      nonce: SimHelperStreamNonce
    }),
    result: SimHelperStartStreamResult
  },
  stopStream: {
    params: z.object({
      udid: z.string(),
      token: z.number().int(),
      // Only this generation: a stream started again under the same token with another nonce stays.
      nonce: SimHelperStreamNonce.optional()
    }),
    result: SimHelperStreamStats
  },
  settle: {
    params: z.object({
      udid: z.string(),
      // 100 to 5000, default 400.
      windowMs: z.number().int().optional(),
      // 200 to 20000 and at least windowMs, default 5000.
      timeoutMs: z.number().int().optional(),
      // 1 to 200, default 48.
      smallPt: z.number().optional()
    }),
    result: SimHelperSettleResult
  }
} as const
export type SimHelperMethod = keyof typeof SIM_HELPER_METHODS
export type SimHelperParams<M extends SimHelperMethod> = z.input<
  (typeof SIM_HELPER_METHODS)[M]['params']
>
export type SimHelperValue<M extends SimHelperMethod> = z.infer<
  (typeof SIM_HELPER_METHODS)[M]['result']
>

/** Each method's deadline inside the helper, which answers `timeout` itself once it passes. */
export const SIM_HELPER_DEADLINES_MS = {
  // waitMs (at most 10 s) for frames, the framebuffer read and the simctl fallback (6 s cap).
  selftest: 20_000,
  attachDisplay: 5_000,
  displayStats: 2_000,
  detachDisplay: 5_000,
  // The framebuffer read, else simctl io screenshot (6 s cap).
  screenshot: 8_000,
  // Connecting (4.2 s at most), an action of at most 8 s or a paste, and the closing barrier (2 s).
  hid: 15_000,
  // A 2.5 s walk budget plus one request in flight.
  ax: 5_000,
  // An attach (a dozen remote calls) and the viewer's name lookup.
  startStream: 5_000,
  stopStream: 2_000,
  // timeoutMs (at most 20 s) plus the accessibility read under way when it passes.
  settle: 25_000
} as const satisfies Record<SimHelperMethod, number>

/** How far past its own deadline a helper may be silent before the runtime calls it hung. */
export const SIM_HELPER_DEADLINE_MARGIN_MS = 2_000

/** A call's time in flight; waiting for a helper that is starting does not count against it. */
export function simHelperCallBudgetMs(method: SimHelperMethod): number {
  return SIM_HELPER_DEADLINES_MS[method] + SIM_HELPER_DEADLINE_MARGIN_MS
}

/** One line from the helper: a reply (id null when the helper could not read the request's id). */
export const SimHelperReplyFrame = z.union([
  z.object({ id: z.number().int().nullable(), result: z.record(z.string(), z.unknown()) }),
  z.object({
    id: z.number().int().nullable(),
    error: z.object({ code: z.enum(SIM_HELPER_ERROR_CODES), message: z.string() })
  })
])
export type SimHelperReplyFrame = z.infer<typeof SimHelperReplyFrame>
