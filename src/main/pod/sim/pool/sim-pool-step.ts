// Fork-only (Pod): the pool core's one entry point. Given the registry, this runtime's memory, a
// command and the clock, it returns the next registry, the next memory, the effects for the
// adapters (lease files first) and the caller's answer, plus when it next needs a step (`wakeAt`,
// monotonic ms) so the coordinator sleeps on one timer instead of polling. No I/O.
import { revokeIdle } from '../leases/sim-lease-idle'
import {
  leaseCall,
  releaseCall,
  resetCall,
  verbCall,
  waitMineCall,
  type SimAnswerLater
} from '../leases/sim-lease-calls'
import { endLease, pruneTombstones } from '../leases/sim-lease-records'
import { updateQueue } from '../leases/sim-lease-queue'
import {
  giveBackCall,
  humanInputCall,
  takeoverCall,
  takeoverDeviceCall
} from '../leases/sim-lease-takeover'
import { applyLiveness, runLeaseTimers } from '../leases/sim-lease-timers'
import { allocate } from './sim-pool-allocate'
import { updateBrakeHold } from './sim-pool-capacity'
import type { SimPoolAnswer, SimPoolCommand } from './sim-pool-commands'
import { adoptOrphans, expireOps, finishOp } from './sim-pool-devices'
import {
  registryChanged,
  simPoolDraft,
  type SimPoolDraft,
  type SimPoolEffect,
  type SimPoolInputs,
  type SimPoolMemory,
  type SimPoolRegistry,
  type SimPoolTrace
} from './sim-pool-draft'
import { leaseFileEffects } from './sim-pool-lease-files'
import { reconcileDevices } from './sim-pool-reconcile'
import { settleHeldDevices, shutDownUnheld } from './sim-pool-unheld'
import type { SimCapacityReading } from './sim-pool-ports'
import { foldWindows, observeClock } from './sim-pool-windows'

export type SimPoolState = Readonly<{ registry: SimPoolRegistry; memory: SimPoolMemory }>

export type SimPoolStepResult = Readonly<{
  registry: SimPoolRegistry
  memory: SimPoolMemory
  effects: readonly SimPoolEffect[]
  trace: readonly SimPoolTrace[]
  answer: SimPoolAnswer
  // Whether the registry must be written (compare-and-swap); false leaves the file alone.
  changed: boolean
  wakeAt: number | null
}>

const NONE: SimAnswerLater = () => ({ kind: 'none' })

/** A reading taken for this call stands in for the last poll's (devices and holders unchanged). */
function readCapacity(d: SimPoolDraft, capacity: SimCapacityReading): void {
  const last = d.memory.observation
  d.memory.observation = last
    ? { ...last, capacity }
    : {
        at: d.now,
        devices: { verdict: 'unknown', why: 'not listed yet' },
        capacity,
        liveness: {},
        runtimes: {},
        externalUse: []
      }
}

function apply(d: SimPoolDraft, command: SimPoolCommand): SimAnswerLater {
  switch (command.kind) {
    case 'poll':
      d.memory.observation = command.observation
      return NONE
    case 'lease':
      if (command.capacity) {
        readCapacity(d, command.capacity)
      }
      return leaseCall(d, command.request)
    case 'waitMine':
      return waitMineCall(d, command.caller)
    case 'release':
      return releaseCall(d, command.caller)
    case 'verb':
      return verbCall(d, command.caller, command.verb, command.access)
    case 'reset':
      return resetCall(d, command.caller, command.scope)
    case 'takeover':
      return takeoverCall(d, command.leaseId)
    case 'takeoverDevice':
      return takeoverDeviceCall(d, command.udid, command.person, command.worktreeRoot)
    case 'humanInput':
      humanInputCall(d, command.leaseId)
      return NONE
    case 'giveBack':
      giveBackCall(d, command.leaseId)
      return NONE
    case 'opFinished': {
      const device = d.registry.devices.find((candidate) => candidate.udid === command.udid)
      if (device) {
        finishOp(d, device, command.op, command.outcome)
      }
      return NONE
    }
    case 'buildFinished':
      for (const lease of d.registry.leases) {
        if (lease.queue?.buildId !== command.buildId) {
          continue
        }
        if (command.ok) {
          const queue = { ...lease.queue }
          delete queue.buildId
          lease.queue = queue
        } else {
          endLease(d, lease, 'buildFailed', 'buildFailed', command.buildId)
        }
      }
      return NONE
    case 'worktreeRemoved':
      for (const lease of d.registry.leases) {
        if (lease.worktreeRoot === command.worktreeRoot) {
          endLease(d, lease, 'worktreeRemoved', 'worktreeRemoved')
        }
      }
      return NONE
  }
}

/** Every rule, in order, after any command: the pool is always left consistent. */
function settle(d: SimPoolDraft, polled: boolean, writtenAt: number): void {
  updateBrakeHold(d)
  adoptOrphans(d)
  expireOps(d)
  if (polled) {
    reconcileDevices(d, writtenAt)
  }
  runLeaseTimers(d)
  if (polled) {
    applyLiveness(d)
  }
  allocate(d)
  revokeIdle(d)
  settleHeldDevices(d)
  allocate(d)
  shutDownUnheld(d)
  updateQueue(d)
  if (polled) {
    // A day-long window: the poll cadence is precise enough, and command steps skip the scan.
    pruneTombstones(d)
  }
  foldWindows(d)
}

export function simPoolStep(
  state: SimPoolState,
  command: SimPoolCommand,
  inputs: SimPoolInputs
): SimPoolStepResult {
  const d = simPoolDraft(state, inputs)
  observeClock(d)
  const answer = apply(d, command)
  settle(d, command.kind === 'poll', state.registry.updatedAt)
  const files = leaseFileEffects(d, state.registry.devices)
  const changed = registryChanged(state.registry, d.registry)
  if (changed) {
    d.registry.updatedAt = Math.max(d.now.wall, state.registry.updatedAt + 1)
  }
  return {
    registry: d.registry,
    memory: d.memory,
    // Lease files before the device work they cover; waiters hear last, once all is decided.
    effects: [
      ...files,
      ...d.effects.filter((effect) => effect.kind !== 'notifyWaiter'),
      ...d.effects.filter((effect) => effect.kind === 'notifyWaiter')
    ],
    trace: d.trace,
    answer: answer(),
    changed,
    wakeAt: d.wakeAt
  }
}
