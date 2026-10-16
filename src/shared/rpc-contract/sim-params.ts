// Fork-only (Pod): params of the `sim.*` RPC methods (iOS simulators for agents), which a runtime
// serves only when status.get lists `pod.sim.v1`. Every verb that touches a device carries the
// caller, from which the runtime finds the caller's lease (pod-sim/sim-holder.ts). Strict objects:
// a newer CLI's key reaches an older runtime as a refusal, never as a silently dropped option. The
// caller alone is lenient: its fields are hints, and a newer CLI's hint is dropped.
import { z } from 'zod'
import {
  SIM_LEASE_MAX_WAIT_S,
  SIM_LOGS_MAX_BYTES,
  SIM_LOGS_MAX_LINES,
  SIM_STATE_MAX_NODES,
  SIM_TYPE_MAX_CHARS
} from '../pod-sim/sim-call-limits'
import { SimAbsolutePath, SimCaller } from '../pod-sim/sim-holder'
import { SIM_RECIPE_APP_ID_PATTERN } from '../pod-sim/sim-recipe'

const Seconds = z.number().min(0).max(SIM_LEASE_MAX_WAIT_S)
const Text = z.string().min(1).max(1024)
// Device points (the accessibility frames' space), origin top-left.
const Coordinate = z.number().finite().min(0).max(10_000)
const Point = z.object({ x: Coordinate, y: Coordinate }).strict()
const Direction = z.enum(['up', 'down', 'left', 'right'])

const scoped = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ caller: SimCaller, ...shape }).strict()

/** What a tap or a scroll aims at: an index from `state`, a label, a test id, or a point. */
export const SimTarget = z.discriminatedUnion('by', [
  z.object({ by: z.literal('index'), index: z.number().int().nonnegative() }).strict(),
  z.object({ by: z.literal('label'), text: Text, exact: z.boolean().optional() }).strict(),
  z.object({ by: z.literal('id'), text: Text }).strict(),
  z.object({ by: z.literal('point'), x: Coordinate, y: Coordinate }).strict()
])

export const SimLeaseParams = scoped({
  app: z.string().regex(SIM_RECIPE_APP_ID_PATTERN).optional(),
  // `iphone`, `ipad`, or a model such as `iPhone 16 Pro`.
  device: z.string().min(1).max(128).optional(),
  wait: Seconds.optional()
})
export const SimWaitLeaseParams = scoped({ wait: Seconds.optional() })
export const SimCallerParams = scoped({})
export const SimStatusParams = z.object({ caller: SimCaller.optional() }).strict()
export const SimUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()
export const SimOpenParams = scoped({ port: z.number().int().min(1024).max(65535).optional() })
export const SimStateParams = scoped({
  screenshot: z.boolean().optional(),
  maxNodes: z.number().int().min(1).max(SIM_STATE_MAX_NODES).optional(),
  filter: z.string().min(1).max(256).optional(),
  // Off-screen nodes too.
  all: z.boolean().optional()
})
export const SimTapParams = scoped({ target: SimTarget, screenshot: z.boolean().optional() })
export const SimTypeParams = scoped({
  text: z.string().min(1).max(SIM_TYPE_MAX_CHARS),
  // How text without a US key usage goes in: the pasteboard (iOS asks to allow the paste) or XCTest.
  nonAscii: z.enum(['paste', 'xctest']).optional(),
  submit: z.boolean().optional()
})
export const SIM_KEYS = [
  'return',
  'delete',
  'forwardDelete',
  'tab',
  'escape',
  'space',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'home',
  'end',
  'pageUp',
  'pageDown'
] as const
export const SimKeyParams = scoped({
  // A named key, or one printable ASCII character.
  key: z.union([z.enum(SIM_KEYS), z.string().regex(/^[ -~]$/)]),
  modifiers: z
    .array(z.enum(['shift', 'control', 'option', 'command']))
    .max(4)
    .optional()
})
export const SimSwipeParams = scoped({
  from: Point,
  to: Point,
  durationMs: z.number().int().min(50).max(5000).optional(),
  // Starts on the screen's edge (iOS back and system gestures).
  edge: z.enum(['left', 'right', 'top', 'bottom']).optional()
})
export const SimScrollParams = scoped({
  direction: Direction,
  target: SimTarget.optional(),
  // In screens.
  amount: z.number().min(0.1).max(10).optional()
})
export const SimButtonParams = scoped({
  button: z.enum(['home', 'lock', 'siri', 'volumeUp', 'volumeDown'])
})
export const SimRotateParams = scoped({
  orientation: z.enum(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'])
})
export const SimWaitParams = scoped({
  until: z.discriminatedUnion('by', [
    // The accessibility tree stable and no damage beyond small areas (caret, spinner).
    z.object({ by: z.literal('settle') }).strict(),
    z.object({ by: z.literal('text'), text: Text }).strict(),
    z.object({ by: z.literal('gone'), text: Text }).strict()
  ]),
  timeout: z.number().min(0.1).max(SIM_LEASE_MAX_WAIT_S).optional()
})
export const SimScreenshotParams = scoped({
  // Inside the caller's worktree or Pod's evidence folder.
  out: SimAbsolutePath.optional(),
  scale: z.number().min(0.1).max(1).optional(),
  format: z.enum(['png', 'jpeg']).optional()
})
export const SimLogsParams = scoped({
  // Seconds back; absent, since this holder's last `logs`.
  since: z.number().positive().max(86_400).optional(),
  grep: z.string().min(1).max(256).optional(),
  source: z.enum(['app', 'metro', 'js']).optional(),
  maxLines: z.number().int().min(1).max(SIM_LOGS_MAX_LINES).optional(),
  maxBytes: z.number().int().min(1024).max(SIM_LOGS_MAX_BYTES).optional()
})
export const SimOpenUrlParams = scoped({
  url: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z][A-Za-z0-9+.-]*:/)
})
export const SimPushParams = scoped({
  payload: z.record(z.string(), z.unknown()),
  bundleId: z.string().min(1).max(256).optional()
})
export const SimLocationParams = z.union([
  scoped({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  scoped({ clear: z.literal(true) })
])
export const SIM_PRIVACY_SERVICES = [
  'all',
  'calendar',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'photos-add',
  'photos',
  'media-library',
  'microphone',
  'motion',
  'reminders',
  'siri'
] as const
export const SimPrivacyParams = scoped({
  action: z.enum(['grant', 'revoke', 'reset']),
  service: z.enum(SIM_PRIVACY_SERVICES),
  // The lease's app when absent.
  bundleId: z.string().min(1).max(256).optional()
})
export const SimAppearanceParams = scoped({ mode: z.enum(['light', 'dark']) })
export const SimPbcopyParams = scoped({ text: z.string().min(1).max(SIM_TYPE_MAX_CHARS) })
export const SimAddMediaParams = scoped({ paths: z.array(SimAbsolutePath).min(1).max(20) })
// `device` erases and re-applies the project's defaults on the same UDID.
export const SimResetParams = scoped({ scope: z.enum(['app', 'device']) })
export const SimRecordParams = scoped({
  action: z.enum(['start', 'stop']),
  out: SimAbsolutePath.optional()
})

export const SIM_RPC_METHODS = [
  'sim.lease',
  'sim.waitLease',
  'sim.release',
  'sim.udid',
  'sim.status',
  'sim.subscribe',
  'sim.unsubscribe',
  'sim.open',
  'sim.state',
  'sim.tap',
  'sim.type',
  'sim.key',
  'sim.swipe',
  'sim.scroll',
  'sim.button',
  'sim.rotate',
  'sim.wait',
  'sim.screenshot',
  'sim.logs',
  'sim.openUrl',
  'sim.push',
  'sim.location',
  'sim.privacy',
  'sim.appearance',
  'sim.pbcopy',
  'sim.addMedia',
  'sim.reset',
  'sim.record'
] as const
export type SimRpcMethod = (typeof SIM_RPC_METHODS)[number]

/** Every sim method and its params; null takes none (the stream, as accounts.subscribe). */
export const SIM_RPC_PARAMS_BY_METHOD = {
  'sim.lease': SimLeaseParams,
  'sim.waitLease': SimWaitLeaseParams,
  'sim.release': SimCallerParams,
  'sim.udid': SimCallerParams,
  'sim.status': SimStatusParams,
  'sim.subscribe': null,
  'sim.unsubscribe': SimUnsubscribeParams,
  'sim.open': SimOpenParams,
  'sim.state': SimStateParams,
  'sim.tap': SimTapParams,
  'sim.type': SimTypeParams,
  'sim.key': SimKeyParams,
  'sim.swipe': SimSwipeParams,
  'sim.scroll': SimScrollParams,
  'sim.button': SimButtonParams,
  'sim.rotate': SimRotateParams,
  'sim.wait': SimWaitParams,
  'sim.screenshot': SimScreenshotParams,
  'sim.logs': SimLogsParams,
  'sim.openUrl': SimOpenUrlParams,
  'sim.push': SimPushParams,
  'sim.location': SimLocationParams,
  'sim.privacy': SimPrivacyParams,
  'sim.appearance': SimAppearanceParams,
  'sim.pbcopy': SimPbcopyParams,
  'sim.addMedia': SimAddMediaParams,
  'sim.reset': SimResetParams,
  'sim.record': SimRecordParams
} as const satisfies Record<SimRpcMethod, z.ZodType | null>
