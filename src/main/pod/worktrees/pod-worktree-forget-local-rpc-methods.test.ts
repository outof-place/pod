import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcResponse } from '../../runtime/rpc/core'
import type { RpcCallerScope } from '../../runtime/rpc/rpc-caller-scope'
import { OWNER_RPC_CALLER_SCOPE } from '../../runtime/rpc/rpc-caller-scope'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../../runtime/rpc/rpc-caller-identity'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatcher-stream-options'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { getPodWorktreeForgetLocal } from './pod-worktree-forget-local-rpc'
import { podWorktreeForgetRefusal } from './pod-worktree-forget-refusal'
import { POD_WORKTREE_FORGET_LOCAL_METHODS } from './pod-worktree-forget-local-rpc-methods'

// The installed forget is a stub here: the method's own job is who may call it and with what.
vi.mock('./pod-worktree-forget-local-rpc', () => ({ getPodWorktreeForgetLocal: vi.fn() }))

const forget = vi.fn(async () => {})
const params = { worktreeId: 'repo-1::/workspace/feature', hostId: 'ssh:gone' }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

function dispatch(
  sent: unknown,
  options?: RpcDispatchStreamingOptions,
  callerScope?: RpcCallerScope
): Promise<RpcResponse> {
  return new RpcDispatcher({
    runtime,
    methods: POD_WORKTREE_FORGET_LOCAL_METHODS,
    callerScope
  }).dispatch(
    { id: 'req-1', authToken: 'tok', method: 'worktree.forgetLocal', params: sent },
    options
  )
}

beforeEach(() => {
  forget.mockReset()
  forget.mockResolvedValue(undefined)
  vi.mocked(getPodWorktreeForgetLocal).mockReturnValue(forget)
})

describe('worktree.forgetLocal', () => {
  it('is advertised, so a client offers Remove only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.worktree.forget-local.v1')
  })

  it('declares host-admin and stays off the paired-mobile allowlist', () => {
    expect(
      POD_WORKTREE_FORGET_LOCAL_METHODS.map((method) => [method.name, method.permission])
    ).toEqual([['worktree.forgetLocal', 'host-admin']])
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('worktree.forgetLocal')).toBe(false)
  })

  it("forgets for PodNative's unary call, its local stream and the desktop, with exactly what they sent", async () => {
    for (const options of [
      undefined,
      {
        caller: LOCAL_CLI_RPC_CALLER,
        callerScope: OWNER_RPC_CALLER_SCOPE,
        clientKind: 'runtime' as const,
        connectionId: 'stream-1'
      },
      { caller: DESKTOP_RPC_CALLER }
    ]) {
      await expect(dispatch(params, options)).resolves.toMatchObject({
        ok: true,
        result: { forgotten: true }
      })
    }
    expect(forget.mock.calls).toEqual([[params], [params], [params]])
  })

  it("refuses an SSH host's orca CLI, with remote control on or off, before anything is forgotten", async () => {
    for (const remoteCliControl of [true, false]) {
      await expect(
        dispatch(params, undefined, { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl })
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(forget).not.toHaveBeenCalled()
  })

  it('refuses a paired device, even one granted desktop control at pairing, and the phone', async () => {
    for (const grants of [[], ['desktop-control']] as const) {
      await expect(
        dispatch(params, { pairedDeviceId: 'device-1' }, { kind: 'runtime-paired', grants })
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    await expect(
      dispatch(params, { pairedDeviceId: 'phone-1', clientKind: 'mobile' }, { kind: 'mobile' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(forget).not.toHaveBeenCalled()
  })

  it('refuses params beyond one workspace on one named host', async () => {
    for (const sent of [
      undefined,
      {},
      { worktreeId: params.worktreeId },
      { hostId: params.hostId },
      { ...params, force: true },
      { ...params, hostId: '' },
      { ...params, worktreeId: 42 }
    ]) {
      await expect(dispatch(sent), JSON.stringify(sent)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(forget).not.toHaveBeenCalled()
  })

  it("passes the forget's refusal through with its reason", async () => {
    forget.mockRejectedValue(podWorktreeForgetRefusal('host_connected'))
    await expect(dispatch(params)).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_forget_refused', data: { reason: 'host_connected' } }
    })
  })

  it('answers runtime_unavailable where the forget was never installed', async () => {
    vi.mocked(getPodWorktreeForgetLocal).mockReturnValue(null)
    await expect(dispatch(params)).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
  })
})
