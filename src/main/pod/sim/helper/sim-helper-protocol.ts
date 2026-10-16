// Fork-only (Pod): the pod-sim helper's protocol v1 as the runtime reads it. The helper
// (native/pod-sim-macos) is the only Pod process that loads CoreSimulator and SimulatorKit; the two
// ship in one bundle, so there is one version and no compatibility window. Wire: one JSON object per
// line on the helper's stdio, at most SIM_HELPER_MAX_FRAME_BYTES before the newline. The shared
// fixture native/pod-sim-macos/Fixtures/protocol-v1.json is decoded by both sides' tests.
import { z } from 'zod'

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
  'timeout',
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
  xcode: z
    .object({
      developerDir: z.string(),
      source: z.enum(['DEVELOPER_DIR', 'xcode-select']),
      version: z.string().optional(),
      build: z.string().optional()
    })
    .optional(),
  coreSimulator: Framework.optional(),
  simulatorKit: Framework.optional(),
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
  // POD_SIM_DEVICE_SET: a device set other than the default (probes only; the pool uses the default).
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

export const SimHelperAttachResult = z.object({
  udid: z.string(),
  surface: z
    .object({ width: z.number().int(), height: z.number().int(), id: z.number().int() })
    .optional(),
  alreadyAttached: z.boolean()
})

export const SimHelperDisplayStats = z.object({
  udid: z.string(),
  seconds: z.number(),
  // One per presented frame; 0 while the screen is static.
  frameCallbacks: z.number().int(),
  surfaceCallbacks: z.number().int(),
  // Frames whose surface seed changed: what a viewer redraws.
  seedChanges: z.number().int()
})

export const SimHelperScreenshot = z.object({
  path: z.string(),
  format: z.enum(['png', 'jpeg']),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  // `simctl`: `simctl io screenshot`, when the framebuffer path is off or failed (fallbackReason says why).
  source: z.enum(['surface', 'simctl']),
  ms: z.number().int(),
  fallbackReason: z.string().optional()
})

const Udid = z.object({ udid: z.string() })

/** Each method's params and result; params are what the runtime sends. */
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
  screenshot: 8_000
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
