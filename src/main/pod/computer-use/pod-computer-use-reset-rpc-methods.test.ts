import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcResponse } from '../../runtime/rpc/core'
import type { RpcCallerScope } from '../../runtime/rpc/rpc-caller-scope'
import { OWNER_RPC_CALLER_SCOPE } from '../../runtime/rpc/rpc-caller-scope'
import { LOCAL_CLI_RPC_CALLER } from '../../runtime/rpc/rpc-caller-identity'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatcher-stream-options'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { resetComputerUsePermissions } from '../../computer/macos-computer-use-permissions'
import { resetMacosTccPermission } from '../../macos-tcc-reset'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { POD_COMPUTER_USE_RESET_METHODS } from './pod-computer-use-reset-rpc-methods'

// Never the real reset: it runs tccutil on this account's TCC database and pkill on the helper,
// which no isolated HOME keeps away from the live Pod's Computer Use. Both modules are stubs.
vi.mock('../../computer/macos-computer-use-permissions', () => ({
  resetComputerUsePermissions: vi.fn(async () => ({
    platform: 'darwin',
    helperAppPath: '/Applications/Pod.app/Contents/Helpers/Pod Computer Use.app',
    helperUnavailableReason: null,
    permissions: [],
    bundleId: 'codes.pod.app.computer-use'
  }))
}))
vi.mock('../../macos-tcc-reset', () => ({
  readMacosBundleId: vi.fn(() => {
    throw new Error('the real Info.plist read must not run in this test')
  }),
  resetMacosTccPermission: vi.fn(() => {
    throw new Error('the real tccutil must not run in this test')
  })
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

function dispatch(
  params: unknown,
  options?: RpcDispatchStreamingOptions,
  callerScope?: RpcCallerScope
): Promise<RpcResponse> {
  return new RpcDispatcher({
    runtime,
    methods: POD_COMPUTER_USE_RESET_METHODS,
    callerScope
  }).dispatch(
    { id: 'req-1', authToken: 'tok', method: 'computer.permissionsReset', params },
    options
  )
}

/** Every test that can reach the handler first proves the reset is the stub. */
function expectStubbed(): void {
  expect(vi.isMockFunction(resetComputerUsePermissions)).toBe(true)
  expect(vi.isMockFunction(resetMacosTccPermission)).toBe(true)
}

beforeEach(() => {
  vi.mocked(resetComputerUsePermissions).mockClear()
  vi.mocked(resetMacosTccPermission).mockClear()
})

describe('computer.permissionsReset', () => {
  it('is advertised, so a client offers Reset access only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.computer-use.permissions-reset.v1')
  })

  it("declares desktop-control, computer.permissions' own family", () => {
    expect(
      POD_COMPUTER_USE_RESET_METHODS.map((method) => [method.name, method.permission])
    ).toEqual([['computer.permissionsReset', 'desktop-control']])
  })

  it("resets for PodNative's calls on the runtime socket, with or without an empty params object", async () => {
    expectStubbed()
    // The owner token's unary call: no caller scope (the owner's) and no client kind (local-cli).
    for (const params of [undefined, {}]) {
      await expect(dispatch(params)).resolves.toMatchObject({
        ok: true,
        result: { bundleId: 'codes.pod.app.computer-use' }
      })
    }
    expect(resetComputerUsePermissions).toHaveBeenCalledTimes(2)
    expect(vi.mocked(resetComputerUsePermissions).mock.calls).toEqual([[], []])
  })

  it("resets for PodNative's local stream, which stamps local-cli and the owner's scope", async () => {
    expectStubbed()
    await expect(
      dispatch(undefined, {
        caller: LOCAL_CLI_RPC_CALLER,
        callerScope: OWNER_RPC_CALLER_SCOPE,
        clientKind: 'runtime',
        connectionId: 'stream-1'
      })
    ).resolves.toMatchObject({ ok: true })
    expect(resetComputerUsePermissions).toHaveBeenCalledTimes(1)
  })

  it("refuses an SSH host's orca CLI, with remote control on or off, before anything is reset", async () => {
    expectStubbed()
    for (const remoteCliControl of [true, false]) {
      await expect(
        dispatch(undefined, undefined, { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl })
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(resetComputerUsePermissions).not.toHaveBeenCalled()
  })

  it('refuses a paired device, even one granted desktop control at pairing', async () => {
    expectStubbed()
    for (const grants of [[], ['desktop-control']] as const) {
      await expect(
        dispatch(undefined, { pairedDeviceId: 'phone-1' }, { kind: 'runtime-paired', grants })
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(resetComputerUsePermissions).not.toHaveBeenCalled()
  })

  it('refuses any params: nothing a caller sends reaches tccutil', async () => {
    expectStubbed()
    for (const params of [{ x: 1 }, { bundleId: 'com.apple.Terminal' }, { service: 'All' }]) {
      // The schema's refusal, not any other.
      await expect(dispatch(params), JSON.stringify(params)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(resetComputerUsePermissions).not.toHaveBeenCalled()
    expect(resetMacosTccPermission).not.toHaveBeenCalled()
  })
})
