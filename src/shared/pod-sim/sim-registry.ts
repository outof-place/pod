// Fork-only (Pod): the pool's state on disk. One file for the whole Mac account, not per profile:
// a probe runtime and the user's Pod share one pool. A device is the pool's only when this file
// lists it under a Pod device name.
//
// Every change is read-check-write under an exclusive flock on the lock file: read the file,
// check, write `registry.json.<pid>.tmp` beside it, fsync, rename it over the file, unlock. Slow
// work runs outside the lock behind the device's `op`, written before it starts and cleared after:
//   grant   check simDeviceIsFree over the file's leases and no live `op` on the device, then
//           write the lease with `servedBy` (this runtime). No op: it is one locked write.
//   boot    check no live `op` and the cap (every device whose state counts toward it, plus boot,
//           prepare and reset ops in flight, plus devices booted outside Pod), write op `boot`,
//           unlock, boot, lock, clear it.
//   clone   write the new device with op `clone` first, clone, then clear it.
//   delete  check no live lease names it and no live `op`, write op `delete`, delete, then remove
//           the entry.
// An op or a lease whose runtime (`by`, `servedBy`) has exited (pid plus start time) is stale, and
// the next runtime that takes the lock takes it over. An op past its deadline fails its device
// even while its runtime lives.
//
// Versions: a file this runtime cannot read, or one a newer Pod wrote, turns its pool off
// (`registryUnreadable`) and this runtime never writes it. Any new value in a vocabulary the file
// holds (lease state, holder kind, device role, op kind, end reason) bumps SIM_REGISTRY_VERSION,
// so an unknown value in a file of this version is damage, not news. Unknown fields are kept, at
// every level, on the next write.
import { z } from 'zod'
import { SimAbsolutePath } from './sim-holder'
import { SIM_DEVICE_STATES, SIM_LEASE_FINAL_STATES } from './sim-lifecycle'
import { SIM_POD_DEVICE_NAME_PATTERN, SimLease, SimLeaseEnded, SimUdid } from './sim-pool-snapshot'

export const SIM_REGISTRY_VERSION = 1
/** Under the account's home, never under a Pod profile. */
export const SIM_REGISTRY_DIRECTORY = ['Library', 'Application Support', 'codes.pod.sim'] as const
export const SIM_REGISTRY_FILE_NAME = 'registry.json'
export const SIM_REGISTRY_LOCK_FILE_NAME = 'registry.lock'

const EpochMs = z.number().int().nonnegative()

/**
 * A runtime process: pid plus its start, seconds since the epoch, as liveness checks it, and the
 * Pod profile (its userData) it runs, which outlives a restart of that Pod: a restarted Pod sees
 * the panes and agent sessions its previous process saw (the terminal daemon survives).
 */
export const SimRuntimeRef = z.looseObject({
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  profile: z.string().min(1).max(128).optional()
})

/** The slow device work a runtime has in flight, outside the lock. */
export const SIM_DEVICE_OPS = [
  'create',
  'clone',
  'prepare',
  'boot',
  'reset',
  'release',
  'shutDown',
  'delete'
] as const

export const SimRegistryDevice = z.looseObject({
  udid: SimUdid,
  name: z.string().regex(SIM_POD_DEVICE_NAME_PATTERN),
  role: z.enum(['golden', 'pool']),
  deviceType: z.string().min(1).max(128),
  runtime: z.string().min(1).max(64),
  createdAt: EpochMs,
  clonedFrom: SimUdid.optional(),
  affinity: SimAbsolutePath.optional(),
  op: z.looseObject({ kind: z.enum(SIM_DEVICE_OPS), by: SimRuntimeRef, since: EpochMs }).optional(),
  // Where the pool core last moved it through SIM_DEVICE_TRANSITIONS; the pool checks it against
  // simctl on every poll.
  state: z.enum(SIM_DEVICE_STATES).optional(),
  // Why it is `failed` (an op past its deadline, a failed erase); `count` failures in a row, reset
  // by a good boot.
  failure: z
    .looseObject({
      at: EpochMs,
      message: z.string().min(1).max(1024),
      op: z.enum(SIM_DEVICE_OPS).optional(),
      count: z.number().int().positive()
    })
    .optional()
})

// Live leases, restored after a runtime restart, each with the runtime that serves it (answers
// its calls) and the runtime that resolved its holder: only that one can see the holder's panes
// and agent sessions, so only it may read them as gone. Adopting a crashed runtime's lease moves
// `servedBy`, never `resolvedBy`; a lease without it was resolved by its `servedBy`.
export const SimRegistryLease = SimLease.extend({
  servedBy: SimRuntimeRef,
  resolvedBy: SimRuntimeRef.optional()
})

// An ended lease, kept 24 hours or until its key leases again, so the holder's late call (from
// either runtime, after a restart too) hears why it ended.
export const SimRegistryTombstone = SimRegistryLease.extend({
  state: z.enum(SIM_LEASE_FINAL_STATES),
  ended: SimLeaseEnded
})

// A kind of device (model plus iOS runtime) the pool failed to make or start `count` times in a
// row, Mac-wide: past a few it stops making that kind for a while, and its waiters hear the last
// failure. A device of the kind booting clears it.
export const SimRegistryMakeFailure = z.looseObject({
  deviceType: z.string().min(1).max(128),
  runtime: z.string().min(1).max(64),
  count: z.number().int().positive(),
  at: EpochMs,
  op: z.enum(SIM_DEVICE_OPS),
  message: z.string().min(1).max(1024)
})

export const SimRegistryFile = z.looseObject({
  version: z.literal(SIM_REGISTRY_VERSION),
  updatedAt: EpochMs,
  devices: z.array(SimRegistryDevice),
  leases: z.array(SimRegistryLease),
  tombstones: z.array(SimRegistryTombstone).optional(),
  makeFailures: z.array(SimRegistryMakeFailure).optional()
})
export type SimRegistryFile = z.infer<typeof SimRegistryFile>

export type SimRegistryRead =
  | { ok: true; registry: SimRegistryFile }
  | { ok: false; reason: 'registryUnreadable'; message: string }

const DISPLAY_PATH = `~/${SIM_REGISTRY_DIRECTORY.join('/')}/${SIM_REGISTRY_FILE_NAME}`

/** The registry's text as this runtime may use it; null text is a file not there yet. */
export function readSimRegistry(text: string | null): SimRegistryRead {
  if (text === null) {
    return {
      ok: true,
      registry: { version: SIM_REGISTRY_VERSION, updatedAt: 0, devices: [], leases: [] }
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return unreadable(
      `${DISPLAY_PATH} is not JSON; Pod leaves it alone (move it aside to start a new pool).`
    )
  }
  const version = z.looseObject({ version: z.number() }).safeParse(json)
  if (version.success && version.data.version > SIM_REGISTRY_VERSION) {
    return unreadable(
      `${DISPLAY_PATH} is from a newer Pod (version ${version.data.version}); update this Pod to share its simulators.`
    )
  }
  const parsed = SimRegistryFile.safeParse(json)
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'the top level'
    return unreadable(
      `${DISPLAY_PATH} is damaged at ${where}; Pod leaves it alone (move it aside to start a new pool).`
    )
  }
  return { ok: true, registry: parsed.data }
}

function unreadable(message: string): SimRegistryRead {
  return { ok: false, reason: 'registryUnreadable', message }
}
