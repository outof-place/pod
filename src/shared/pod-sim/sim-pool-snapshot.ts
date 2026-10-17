// Fork-only (Pod): the simulator pool as `sim.status` and `sim.subscribe` publish it: devices,
// live leases (queued ones carry their place), builds, the helper's health and the memory budget
// claude-acc allows. Decoders strip fields they do not know, so a newer runtime may add some; a
// lease keeps them instead, at every level, since the Mac-wide registry persists it.
import { z } from 'zod'
import { SimAbsolutePath, SimHolder } from './sim-holder'
import { SIM_DEVICE_STATES, SIM_LEASE_STATES } from './sim-lifecycle'

const EpochMs = z.number().int().nonnegative()
const Port = z.number().int().min(1).max(65535)

export const SimUdid = z
  .string()
  .regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
export const SimLeaseId = z.string().regex(/^sl_[0-9a-z]{4,32}$/)
export const SimBuildId = z.string().regex(/^sb_[0-9a-z_-]{1,96}$/)

/**
 * Pod's devices are named `<claude-acc simulator_pool_prefix>Pod-…` (`Portivo-Pod-1`,
 * `Portivo-Pod-Golden-iPhone-16-Pro`), so claude-acc counts them in its cap; the pool adopts only
 * devices its registry lists under such a name, never `Portivo-E2E-*` or a script's device.
 */
export const SIM_POD_DEVICE_NAME_PATTERN = /^[A-Za-z0-9]+-Pod-[A-Za-z0-9-]+$/

/** claude-acc's stages 0..3 (sched.py guard_view): boots stop at `brake`, idle leases end from `tight`. */
export const SIM_BRAKES = ['calm', 'tight', 'brake', 'emergency'] as const
export type SimBrake = (typeof SIM_BRAKES)[number]

const CAPABILITY = z.enum(['ok', 'unverified', 'unsupported'])

export const SimHelperStatus = z.object({
  // `unverified`: a build the helper's version table does not know, enabled per its self-test.
  state: z.enum(['ok', 'unverified', 'unsupported', 'absent']),
  xcodeBuild: z.string().max(64).optional(),
  coreSimulator: z.string().max(64).optional(),
  simulatorKit: z.string().max(64).optional(),
  capabilities: z.object({
    display: CAPABILITY,
    screenshot: CAPABILITY,
    input: CAPABILITY,
    accessibility: CAPABILITY,
    settle: CAPABILITY,
    record: CAPABILITY
  })
})

export const SimBudget = z.object({
  // `pod`: claude-acc is off, Pod's own cap setting applies and no brake.
  source: z.enum(['claudeAcc', 'pod']),
  cap: z.number().int().nonnegative(),
  booted: z.number().int().nonnegative(),
  // claude-acc's `agents_in_use` (guard status --json): what the cap is checked against.
  agentsInUse: z.number().int().nonnegative(),
  brake: z.enum(SIM_BRAKES),
  bootsAllowed: z.boolean(),
  footprintMb: z.number().nonnegative().optional()
})

/** iPhones and iPads queue apart: a waiter for one never waits behind a waiter for the other. */
export const SIM_DEVICE_CLASSES = ['iphone', 'ipad'] as const
export type SimDeviceClass = (typeof SIM_DEVICE_CLASSES)[number]

export const SimAppRef = z.looseObject({
  id: z.string().min(1).max(64),
  bundleId: z.string().min(1).max(256)
})

export const SimDevice = z.object({
  udid: SimUdid,
  name: z.string().regex(SIM_POD_DEVICE_NAME_PATTERN),
  // A golden device stays shut down with the project's defaults and no dev client; pool devices
  // are its clones.
  role: z.enum(['golden', 'pool']),
  deviceType: z.string().min(1).max(128),
  deviceClass: z.enum(SIM_DEVICE_CLASSES),
  runtime: z.string().min(1).max(64),
  state: z.enum(SIM_DEVICE_STATES),
  since: EpochMs,
  leaseId: SimLeaseId.optional(),
  reservedFor: SimLeaseId.optional(),
  // The worktree whose app and data it last carried; that worktree's next lease prefers it.
  affinity: SimAbsolutePath.optional(),
  app: z.object({ bundleId: z.string().min(1).max(256), running: z.boolean() }).optional(),
  footprintMb: z.number().nonnegative().optional(),
  slim: z.enum(['verified', 'unverified', 'stock']),
  failure: z.object({ message: z.string().max(1024) }).optional()
})

/**
 * What a waiter waits for: a boot slot, claude-acc's brake to ease, its dev-client build, a device
 * (being made or started for it), or a fresh memory reading from claude-acc (`measurement`: none
 * in the last 30 s, or one that knows no brake stage or count, so no boot until there is one).
 */
export const SIM_QUEUE_WAITS = ['slot', 'brake', 'build', 'device', 'measurement'] as const

/**
 * Why a lease ended. `released` and `holderExited` end it as `released`; the rest are Pod's
 * (`expired`): revoked while idle for a waiter or under the brake, a waiter that stopped calling,
 * the dev-client build it waited for failed, its device gone beyond recovery, its worktree removed.
 */
export const SIM_LEASE_END_REASONS = [
  'released',
  'holderExited',
  'worktreeRemoved',
  'idleForWaiter',
  'memoryBrake',
  'abandoned',
  'buildFailed',
  'deviceLost'
] as const
export type SimLeaseEndReason = (typeof SIM_LEASE_END_REASONS)[number]

export const SimLeaseEnded = z.looseObject({
  at: EpochMs,
  reason: z.enum(SIM_LEASE_END_REASONS),
  // buildFailed: the build whose log the holder is pointed at.
  buildId: SimBuildId.optional()
})

export const SimLease = z.looseObject({
  leaseId: SimLeaseId,
  key: z.string().min(1).max(8192),
  state: z.enum(SIM_LEASE_STATES),
  holder: SimHolder,
  // A realpath, half of the key.
  worktreeRoot: SimAbsolutePath,
  // The runtime's id for the worktree at worktreeRoot (never the caller's POD_WORKTREE_ID).
  worktreeId: z.string().min(1).max(4096).optional(),
  udid: SimUdid.optional(),
  app: SimAppRef.optional(),
  metroPort: Port.optional(),
  since: EpochMs,
  // The holder's last sim verb (a `wait --mine` counts): idle leases are revoked for a waiter or
  // under the brake, and a waiter silent for SIM_WAITER_ABANDON_S is abandoned.
  lastActivity: EpochMs,
  reservedUntil: EpochMs.optional(),
  queue: z
    .looseObject({
      // 1 is served next. Waiters are served by `since`, oldest first.
      position: z.number().int().positive(),
      // When it joined the queue; a lapsed reservation rejoins with the lapse time (the back).
      since: EpochMs,
      waitingFor: z.enum(SIM_QUEUE_WAITS),
      buildId: SimBuildId.optional()
    })
    .optional(),
  takeover: z.looseObject({ since: EpochMs, lastInput: EpochMs }).optional(),
  ended: SimLeaseEnded.optional(),
  // What `lease --device` asked for (iphone when it asked nothing): one queue per device class,
  // and a model, when named, picks among that class's devices.
  wants: z
    .looseObject({
      deviceClass: z.enum(SIM_DEVICE_CLASSES),
      deviceType: z.string().min(1).max(128).optional()
    })
    .optional()
})
export type SimLease = z.infer<typeof SimLease>

export const SimBuild = z.object({
  buildId: SimBuildId,
  appId: z.string().min(1).max(64).optional(),
  bundleId: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(256),
  state: z.enum(['queued', 'building', 'failed']),
  startedAt: EpochMs,
  progress: z.number().min(0).max(1).optional(),
  phase: z.string().max(256).optional(),
  // Leases that join this build instead of starting one: one build per fingerprint per Mac.
  waiting: z.array(SimLeaseId),
  logPath: SimAbsolutePath.optional(),
  failure: z.object({ message: z.string().max(1024) }).optional()
})

export const SIM_UNAVAILABLE_REASONS = [
  'notMacOS',
  'noXcode',
  'noSimulatorRuntime',
  'disabled',
  'helperUnsupported',
  // The Mac-wide registry is unreadable, or a newer Pod wrote it: this runtime leaves it alone.
  'registryUnreadable'
] as const

export const SimPoolSnapshot = z.object({
  // Grows with every change; a subscriber that sees the same revision has nothing new.
  revision: z.number().int().nonnegative(),
  at: EpochMs,
  available: z.boolean(),
  unavailable: z
    .object({ reason: z.enum(SIM_UNAVAILABLE_REASONS), message: z.string().max(1024) })
    .optional(),
  helper: SimHelperStatus,
  budget: SimBudget,
  devices: z.array(SimDevice),
  leases: z.array(SimLease),
  builds: z.array(SimBuild)
})
export type SimPoolSnapshot = z.infer<typeof SimPoolSnapshot>
