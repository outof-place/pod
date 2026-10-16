// Fork-only (Pod): the numbers the pool core decides with, and why each is what it is.
import type { SimDeviceClass } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SIM_DEVICE_OPS } from '../../../../shared/pod-sim/sim-registry'

export type SimDeviceOp = (typeof SIM_DEVICE_OPS)[number]

export type SimPoolConfig = Readonly<{
  // claude-acc's simulator_pool_prefix: Pod's devices are `<prefix>Pod-<n>`.
  namePrefix: string
  // Pod's own boot cap, used when claude-acc's is 0 (no cap there). Never unlimited.
  podCap: number
  // claude-acc's simulator_idle_minutes: an active lease with no sim call this long is idle.
  idleMs: number
  // How long a booted device nobody holds stays up for the next lease.
  warmMs: number
  // Pool devices per class, golden ones not counted: the cap plus room for held devices that are
  // down and clones waiting for a slot to be slimmed.
  maxDevicesPerClass: number
  // What a new pool device of each class is; a class with none is one the pool cannot make.
  deviceTypes: Readonly<Partial<Record<SimDeviceClass, { deviceType: string; runtime: string }>>>
}>

// 10 minutes warm: an agent's release and re-lease between steps of one task, or the next agent
// in the queue, gets the device in seconds instead of a 5 to 10 s boot plus an app launch; the
// price is about 1.35 GB for at most 10 minutes, and `tight` shuts it down at once.
export const SIM_POOL_DEFAULTS = {
  podCap: 2,
  idleMs: 30 * 60_000,
  warmMs: 10 * 60_000,
  maxDevicesPerClass: 4
} as const

/** claude-acc keeps its brake stage for 30 s after a measurement (sched.py guard_view). */
export const SIM_CAPACITY_FRESH_MS = 30_000
/** A measurement stamped this far in the future is a clock step, not a fresh one. */
export const SIM_CAPACITY_FUTURE_MS = 5_000

/**
 * After the brake (or Pod shutting a device down for it), boots wait until claude-acc has read
 * calm this long without a break: longer than a guard flap at its 2 s brake cadence, short next
 * to an agent's flow.
 */
export const SIM_BRAKE_REBOOT_CALM_MS = 2 * 60_000

/**
 * Each registry op's deadline; past it the device fails and the op stops holding its slot, even
 * while its runtime lives. Stage 0 measured clone about 5 s, a clone's first boot 4 to 7 s and
 * re-slim about 14 s; each deadline is many times that, so only a hung op meets it.
 */
export const SIM_OP_DEADLINE_MS: Readonly<Record<SimDeviceOp, number>> = {
  // simctl create or clone of a full device copy: seconds, minutes on a cold disk.
  create: 2 * 60_000,
  clone: 2 * 60_000,
  // boot, simslim apply and verify, shut down: a fresh device's first boot can take a minute.
  prepare: 5 * 60_000,
  boot: 3 * 60_000,
  // shut down, erase, re-slim, boot, reinstall a 92 to 112 MB dev client.
  reset: 10 * 60_000,
  // terminate the holder's app.
  release: 60_000,
  shutDown: 2 * 60_000,
  delete: 2 * 60_000
}

/** A device failing this many times in a row is deleted; its lease ends `deviceLost`. */
export const SIM_DEVICE_MAX_FAILURES = 3

/** Wall and monotonic clocks disagreeing by more than this between ticks is a clock step. */
export const SIM_CLOCK_STEP_MS = 5_000

/** A holder's calls refresh `lastActivity` on disk at most this often; memory has every call. */
export const SIM_ACTIVITY_WRITE_MS = 15_000

/** Ended leases stay this long (or until their key leases again), at most SIM_TOMBSTONE_MAX. */
export const SIM_TOMBSTONE_KEEP_MS = 24 * 60 * 60_000
export const SIM_TOMBSTONE_MAX = 200
