// Fork-only (Pod): a thin client of the orbstack.* runtime RPC methods; the native shell calls the same ones.
import {
  POD_ORBSTACK_RPC,
  type PodOrbstackActionResult,
  type PodOrbstackStatus
} from '../../../../shared/pod-orbstack-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// OrbStack lives on this Mac, so these always go to the local runtime.
const LOCAL = { kind: 'local' } as const

function call<T>(method: string, params?: unknown): Promise<T> {
  return callRuntimeRpc<T>(LOCAL, method, params)
}

export const podOrbstackRpc = {
  isEnabled: async (): Promise<boolean> =>
    (await call<{ enabled: boolean }>(POD_ORBSTACK_RPC.enabled)).enabled,
  getStatus: (): Promise<PodOrbstackStatus> => call(POD_ORBSTACK_RPC.status),
  createMachine: (worktreeId: string, displayName: string): Promise<PodOrbstackActionResult> =>
    call(POD_ORBSTACK_RPC.create, { worktreeId, displayName }),
  deleteMachine: (worktreeId: string): Promise<PodOrbstackActionResult> =>
    call(POD_ORBSTACK_RPC.delete, { worktreeId }),
  startMachine: (name: string): Promise<PodOrbstackActionResult> =>
    call(POD_ORBSTACK_RPC.start, { name }),
  stopMachine: (name: string): Promise<PodOrbstackActionResult> =>
    call(POD_ORBSTACK_RPC.stop, { name }),
  pinDocker: (worktreeId: string, pinned: boolean): Promise<PodOrbstackActionResult> =>
    call(POD_ORBSTACK_RPC.pinDocker, { worktreeId, pinned })
}
