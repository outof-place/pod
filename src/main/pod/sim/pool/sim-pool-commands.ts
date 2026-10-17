// Fork-only (Pod): what the pool core is asked and what it answers. The RPC layer (stage 7) turns
// answers into `sim.*` results and refusals; the coordinator turns polls and op outcomes into
// commands.
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type {
  SIM_QUEUE_WAITS,
  SimDeviceClass,
  SimLeaseEndReason
} from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'
import type { SimPoolDevice, SimPoolLease } from './sim-pool-draft'
import type {
  SimCapacityReading,
  SimOpOutcome,
  SimOpRef,
  SimPoolObservation
} from './sim-pool-ports'

/** Who calls: the lease key resolved by resolveSimLeaseKey, and its two halves. */
export type SimLeaseCaller = Readonly<{ key: string; holder: SimHolder; worktreeRoot: string }>

export type SimLeaseRequest = SimLeaseCaller &
  Readonly<{
    worktreeId?: string
    app?: { id: string; bundleId: string }
    wants?: { deviceClass: SimDeviceClass; deviceType?: string }
    // The dev-client build this lease waits for (stage 5): no device until it finishes.
    buildId?: string
  }>

export type SimPoolCommand =
  | Readonly<{ kind: 'poll'; observation: SimPoolObservation }>
  // `capacity`: read for this call because the last poll's reading was stale (the coordinator).
  | Readonly<{ kind: 'lease'; request: SimLeaseRequest; capacity?: SimCapacityReading }>
  | Readonly<{ kind: 'waitMine'; caller: SimLeaseCaller }>
  | Readonly<{ kind: 'release'; caller: SimLeaseCaller }>
  | Readonly<{ kind: 'verb'; caller: SimLeaseCaller; verb: string; access: 'read' | 'input' }>
  | Readonly<{ kind: 'reset'; caller: SimLeaseCaller; scope: 'app' | 'device' }>
  | Readonly<{ kind: 'takeover'; leaseId: string }>
  | Readonly<{ kind: 'takeoverDevice'; udid: string; person: string; worktreeRoot: string }>
  | Readonly<{ kind: 'humanInput'; leaseId: string }>
  | Readonly<{ kind: 'giveBack'; leaseId: string }>
  | Readonly<{ kind: 'opFinished'; udid: string; op: SimOpRef; outcome: SimOpOutcome }>
  | Readonly<{ kind: 'buildFinished'; buildId: string; ok: boolean }>
  | Readonly<{ kind: 'worktreeRemoved'; worktreeRoot: string }>

/** A refusal as the core knows it; stage 7 adds a build's log path to `build_failed`. */
export type SimGateRefusal =
  | Exclude<SimRefusalInput, { code: 'build_failed' }>
  | Readonly<{ code: 'build_failed'; buildId: string }>

export type SimWaitReason = (typeof SIM_QUEUE_WAITS)[number]

/**
 * Why nothing is being made or started for a waiter (the wire's `stalled`): the pool has no
 * device of the class and model asked for and makes none (stage 7 says how to ask for one it
 * makes), or making or starting its kind failed `failures` times in a row (sim-pool-make-failures).
 */
export type SimStalled =
  | Readonly<{ reason: 'unmakeable' }>
  | Readonly<{ reason: 'failing'; failures: number; failure: string; retryAt?: number }>

export type SimLeaseAnswer =
  | Readonly<{ status: 'ready'; lease: SimPoolLease; device: SimPoolDevice }>
  | Readonly<{
      status: 'waiting'
      lease: SimPoolLease
      position: number
      waitingFor: SimWaitReason
      stalled?: SimStalled
      // The first SIM_WAITING_LIST_MAX waiters ahead and holders now, then how many more.
      ahead: SimHolder[]
      aheadOmitted: number
      holders: SimHolder[]
      holdersOmitted: number
    }>
  | Readonly<{ status: 'heldByHuman'; lease: SimPoolLease }>
  | Readonly<{ status: 'refused'; refusal: SimGateRefusal }>

export type SimVerbAnswer =
  | Readonly<{ allow: true; lease: SimPoolLease; udid: string }>
  | Readonly<{ allow: false; refusal: SimGateRefusal }>

export type SimReleaseAnswer = Readonly<{
  released: boolean
  leaseId?: string
  ended?: { at: number; reason: SimLeaseEndReason }
}>

/** Why the person's takeover did not happen, for the simulator tab to say. */
export type SimTakeoverRefusal =
  | 'reserved'
  | 'waiting'
  | 'leaseEnded'
  | 'leased'
  | 'deviceBusy'
  | 'deviceNotBooted'
  | 'alreadyDriving'

export type SimTakeoverAnswer =
  | Readonly<{ ok: true; lease: SimPoolLease }>
  | Readonly<{ ok: false; reason: SimTakeoverRefusal; leaseId?: string }>

export type SimPoolAnswer =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'lease'; answer: SimLeaseAnswer }>
  | Readonly<{ kind: 'release'; answer: SimReleaseAnswer }>
  | Readonly<{ kind: 'verb'; answer: SimVerbAnswer }>
  | Readonly<{ kind: 'takeover'; answer: SimTakeoverAnswer }>
