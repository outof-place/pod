// Fork-only (Pod): a kind of device (model plus iOS runtime) the pool keeps failing to make or
// start. Each failed create, clone, slim or boot of a device counts against its kind, Mac-wide in
// the registry, and a device of the kind booting clears it. Past SIM_MAKE_FAILURE_LIMIT in a row
// the pool stops making and starting that kind, then tries once after a backoff that doubles with
// each failed try; its waiters hear the last failure and when the next try comes. A config naming
// another kind starts clean.
import type { SimStalled } from './sim-pool-commands'
import {
  SIM_MAKE_BACKOFF_MAX_MS,
  SIM_MAKE_BACKOFF_MS,
  SIM_MAKE_FAILURE_LIMIT,
  type SimDeviceOp
} from './sim-pool-config'
import {
  makeKindKey,
  type SimDeviceKind,
  type SimPoolDevice,
  type SimPoolDraft,
  type SimPoolMakeFailure
} from './sim-pool-draft'
import { touchWindow, windowDue, windowDueAt } from './sim-pool-windows'

const MAKING_OPS: ReadonlySet<SimDeviceOp> = new Set(['create', 'clone', 'prepare', 'boot'])

function sameKind(a: SimDeviceKind, b: SimDeviceKind): boolean {
  return a.deviceType === b.deviceType && a.runtime === b.runtime
}

function failingOf(d: SimPoolDraft, kind: SimDeviceKind): SimPoolMakeFailure | undefined {
  return d.registry.makeFailures?.find((failing) => sameKind(failing, kind))
}

/** The backoff window after the failure in a row numbered `failing.count`. */
function backoff(failing: SimPoolMakeFailure): [key: string, value: string, ms: number] {
  const doublings = failing.count - SIM_MAKE_FAILURE_LIMIT
  return [
    `backoff:${makeKindKey(failing)}`,
    `${failing.count}:${failing.at}`,
    Math.min(SIM_MAKE_BACKOFF_MS * 2 ** doublings, SIM_MAKE_BACKOFF_MAX_MS)
  ]
}

/** A try of the kind under way: once failing, the pool makes one try at a time. */
function tryInFlight(d: SimPoolDraft, kind: SimDeviceKind): boolean {
  return d.registry.devices.some(
    (device) => device.op !== undefined && MAKING_OPS.has(device.op.kind) && sameKind(device, kind)
  )
}

export function noteMakeFailure(
  d: SimPoolDraft,
  device: SimPoolDevice,
  op: SimDeviceOp,
  message: string
): void {
  if (!MAKING_OPS.has(op)) {
    return
  }
  const kind = { deviceType: device.deviceType, runtime: device.runtime }
  const before = failingOf(d, kind)
  const failing: SimPoolMakeFailure = {
    ...kind,
    count: (before?.count ?? 0) + 1,
    at: d.now.wall,
    op,
    message: message.slice(0, 1024)
  }
  const others = (d.registry.makeFailures ?? []).filter((other) => other !== before)
  d.registry.makeFailures = [...others, failing]
  const [key, value] = backoff(failing)
  touchWindow(d, key, value)
}

/** A device of the kind booted: the kind works again. */
export function clearMakeFailures(d: SimPoolDraft, device: SimPoolDevice): void {
  const before = failingOf(d, device)
  if (!before) {
    return
  }
  const others = (d.registry.makeFailures ?? []).filter((other) => other !== before)
  if (others.length > 0) {
    d.registry.makeFailures = others
  } else {
    delete d.registry.makeFailures
  }
}

/** May the pool make, or boot for a waiter, a device of this kind now? */
export function makeGate(d: SimPoolDraft, kind: SimDeviceKind): 'open' | 'failing' {
  const failing = failingOf(d, kind)
  if (!failing || failing.count < SIM_MAKE_FAILURE_LIMIT) {
    return 'open'
  }
  if (tryInFlight(d, kind)) {
    return 'failing'
  }
  const [key, value, ms] = backoff(failing)
  return windowDue(d, key, value, ms) ? 'open' : 'failing'
}

/** What a waiter for this kind hears while it fails: the last failure, and the next try. */
export function failingStall(d: SimPoolDraft, kind: SimDeviceKind): SimStalled | undefined {
  const failing = failingOf(d, kind)
  if (!failing) {
    return undefined
  }
  const waiting = failing.count >= SIM_MAKE_FAILURE_LIMIT && !tryInFlight(d, kind)
  return {
    reason: 'failing',
    failures: failing.count,
    failure: failing.message,
    ...(waiting ? { retryAt: windowDueAt(d, ...backoff(failing)) } : {})
  }
}
