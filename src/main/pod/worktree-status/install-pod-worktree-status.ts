// Fork-only (Pod): runtime.clientEvents.subscribe's `worktreeStatus` opt-in; off without Pod's identity.
import type { z } from 'zod'
import { getProductIdentity } from '../../product-identity/product-identity'
import type { RpcContext } from '../../runtime/rpc/core'
import { resolveWorktreeCatalogSnapshot } from '../../runtime/rpc/worktree-catalog-snapshot'
import { projectWorktreePsRemovals } from '../../runtime/rpc/worktree-removal-marker-projection'
import { supportsWorktreeVisibilitySourceDefaults } from '../../runtime/rpc/worktree-visibility-client-capability'
import { snapshotPendingWorktreeRemovals } from '../../worktree-removal-listing'
import type {
  PodWorktreeStatusChangedEvent,
  PodWorktreeStatusReadyFields
} from '../../../shared/pod-worktree-status-event'
import type { PodClientEventsSubscribeParams } from '../../../shared/rpc-contract/pod-client-events-params'
import {
  PodWorktreeStatusHub,
  type PodWorktreeStatusRead,
  type PodWorktreeStatusStore
} from './worktree-status-hub'

type SubscribeParams = z.output<typeof PodClientEventsSubscribeParams>
type ReadParams = Exclude<NonNullable<SubscribeParams['worktreeStatus']>, true>
type ReadContext = Pick<RpcContext, 'clientCapabilities'> & {
  runtime: Pick<RpcContext['runtime'], 'getWorktreePs'>
}

let hub: PodWorktreeStatusHub | null = null

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    return false
  }
}

/** Pod builds only. `POD_WORKTREE_STATUS_EVENT=0|1` overrides the identity, for tests. */
export function isPodWorktreeStatusEventEnabled(
  env: NodeJS.ProcessEnv = process.env,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (env.POD_WORKTREE_STATUS_EVENT === '0') {
    return false
  }
  return env.POD_WORKTREE_STATUS_EVENT === '1' || hasIdentity()
}

/** Idempotent; listens to nothing until a client opts in. */
export function installPodWorktreeStatus(
  store: PodWorktreeStatusStore,
  enabled: boolean = isPodWorktreeStatusEventEnabled()
): void {
  if (!hub && enabled) {
    hub = new PodWorktreeStatusHub(store)
  }
}

export function uninstallPodWorktreeStatusForTests(): void {
  hub = null
}

/** Joins one client events subscription to the hub; null when it didn't opt in or Pod is off. */
export function subscribePodWorktreeStatus(
  params: SubscribeParams | undefined,
  context: ReadContext,
  emit: (event: PodWorktreeStatusChangedEvent) => void
): (() => void) | null {
  const options = params?.worktreeStatus
  if (!hub || !options) {
    return null
  }
  const readParams: ReadParams = options === true ? {} : options
  let warned = false
  return hub.subscribe(
    () => readWorktreeStatus(readParams, context),
    emit,
    (error) => {
      if (!warned) {
        warned = true
        console.warn('[pod-worktree-status] worktree.ps read failed:', error)
      }
    },
    { agents: options !== true && options.agents === true }
  )
}

/** The `ready` frame's fields for a subscription `subscribePodWorktreeStatus` joined (or didn't). */
export function podWorktreeStatusReadyFields(
  params: SubscribeParams | undefined,
  stop: (() => void) | null
): PodWorktreeStatusReadyFields {
  if (!stop) {
    return {}
  }
  const options = params?.worktreeStatus
  const agents = options !== undefined && options !== true && options.agents === true
  return { worktreeStatus: true, ...(agents ? { worktreeStatusAgents: true } : {}) }
}

// The worktree.ps pipeline (worktree-catalog-methods.ts), so the event's snapshotId is that read's.
async function readWorktreeStatus(
  params: ReadParams,
  context: ReadContext
): Promise<PodWorktreeStatusRead> {
  const pendingAtScan = snapshotPendingWorktreeRemovals()
  const result = projectWorktreePsRemovals(
    await context.runtime.getWorktreePs(
      params.limit,
      supportsWorktreeVisibilitySourceDefaults(
        context,
        params.supportsWorktreeVisibilitySourceDefaults
      )
    ),
    context,
    pendingAtScan
  )
  const snapshot = resolveWorktreeCatalogSnapshot(result, null)
  if (!('worktrees' in snapshot)) {
    throw new Error('worktree.ps answered unchanged for a read with no snapshot')
  }
  return snapshot
}
