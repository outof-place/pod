// Fork-only (Pod): Linear's admin methods answer only Pod's window and PodNative; agents' methods
// answer only while the user has turned agent access on.
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcRequest } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatcher-stream-options'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../../runtime/rpc/rpc-caller-identity'
import { OWNER_RPC_CALLER_SCOPE, type RpcCallerScope } from '../../runtime/rpc/rpc-caller-scope'
import { LINEAR_METHODS } from '../../runtime/rpc/methods/linear'
import { LINEAR_AGENT_ACCESS_METHODS } from '../../runtime/rpc/methods/linear-agent-access'
import {
  POD_LINEAR_ADMIN_METHODS,
  podLinearRpcRefusal,
  setPodLinearAgentAccessSetting,
  type PodLinearAccessCaller
} from './pod-linear-access'
import { installPodLinear } from './install-pod-linear'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'
import { setSecretStore } from '../../../shared/secret-store'
import { setPodLinearEnabledSetting } from './pod-linear-availability'
import { POD_LINEAR_METHODS } from './pod-linear-rpc-methods'
import { isPodLinearAgentCall } from './pod-linear-call-scope'
import { saveWorkspaceToken } from '../../linear/linear-token-store'
import { upsertWorkspace } from '../../linear/linear-workspace-registry'

const PAIRED: RpcCallerScope = { kind: 'runtime-paired', grants: ['desktop-control'] }
const peer = (ok: boolean) => vi.fn(() => ({ ok, pid: 4242 }))

function caller(overrides: Partial<PodLinearAccessCaller> = {}): PodLinearAccessCaller {
  return { scope: OWNER_RPC_CALLER_SCOPE, identity: LOCAL_CLI_RPC_CALLER, ...overrides }
}

// Linear itself on: what it does while off is pod-linear-availability.test.ts's part.
beforeEach(() => setPodLinearEnabledSetting({ read: () => true, write: () => {} }))
afterEach(() => {
  setPodLinearAgentAccessSetting(null)
  setPodLinearEnabledSetting(null)
})

describe('podLinearRpcRefusal', () => {
  it.each([
    ['Pod’s window', caller({ identity: DESKTOP_RPC_CALLER })],
    ['PodNative by its audit token', caller({ podNativePeer: peer(true) })]
  ])('lets %s change the key', (_who, from) => {
    expect(podLinearRpcRefusal('linear.connect', from)).toBeNull()
  })

  it.each([
    ['the owner token alone (CLI, agents)', caller()],
    ['a process that fails the audit-token check', caller({ podNativePeer: peer(false) })],
    ['a paired desktop', caller({ scope: PAIRED, identity: DESKTOP_RPC_CALLER })],
    ['a phone', caller({ scope: { kind: 'mobile' }, podNativePeer: peer(true) })],
    [
      'an SSH host’s CLI',
      caller({ scope: { kind: 'ssh-bridge', targetId: 'box', remoteCliControl: true } })
    ]
  ])('refuses %s every admin method', (_who, from) => {
    for (const method of POD_LINEAR_ADMIN_METHODS) {
      expect(podLinearRpcRefusal(method, from)).toMatchObject({ code: 'forbidden' })
    }
  })

  it('answers agents only with agent access on, whoever calls', () => {
    const fromPodNative = caller({ podNativePeer: peer(true) })
    expect(podLinearRpcRefusal('linear.issueContext', fromPodNative)).toMatchObject({
      code: 'linear_unavailable'
    })
    setPodLinearAgentAccessSetting({ read: () => true, write: () => {} })
    expect(podLinearRpcRefusal('linear.issueContext', caller())).toBeNull()
  })

  it('leaves other methods alone and checks the audit token only for admin methods', () => {
    const check = peer(true)
    expect(podLinearRpcRefusal('linear.searchIssues', caller({ podNativePeer: check }))).toBeNull()
    expect(podLinearRpcRefusal('worktree.list', caller({ podNativePeer: check }))).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })
})

describe('Linear access through the dispatcher', () => {
  function setup() {
    setTestUserData(mkdtempSync(join(tmpdir(), 'pod-linear-access-')))
    setSecretStore(fakeKeychain())
    let settings: { podLinear?: boolean } = { podLinear: true }
    installPodLinear({
      getSettings: () => settings,
      updateSettings: (updates) => {
        settings = { ...settings, ...updates }
      }
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearConnect: vi.fn().mockResolvedValue({ ok: true }),
      linearSearchForAgents: vi.fn(async () => ({
        issues: [],
        inAgentScope: isPodLinearAgentCall()
      }))
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods under test call only these runtime members.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: [...LINEAR_METHODS, ...LINEAR_AGENT_ACCESS_METHODS, ...POD_LINEAR_METHODS]
    })
    const call = (method: string, params: unknown, options?: RpcDispatchStreamingOptions) => {
      const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
      return dispatcher.dispatch(request, options)
    }
    return { runtime, call }
  }

  const fromPodNative: RpcDispatchStreamingOptions = { podNativePeer: peer(true) }

  it('connects for PodNative and refuses the owner token alone and a paired client', async () => {
    const { runtime, call } = setup()

    expect(await call('linear.connect', { apiKey: 'mock-linear-key-1' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(
      await call(
        'linear.connect',
        { apiKey: 'mock-linear-key-1' },
        { callerScope: PAIRED, pairedDeviceId: 'device-1' }
      )
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(runtime.linearConnect).not.toHaveBeenCalled()

    expect(
      await call('linear.connect', { apiKey: 'mock-linear-key-1' }, fromPodNative)
    ).toMatchObject({
      ok: true
    })
    expect(runtime.linearConnect).toHaveBeenCalledTimes(1)
  })

  it('lets agents in only after PodNative turns agent access on, in the agent call scope', async () => {
    const { runtime, call } = setup()
    const search = { query: 'login' }
    // A grant names the workspaces connected when it's made.
    upsertWorkspace({
      id: 'org-mock-1',
      organizationId: 'org-mock-1',
      organizationName: 'Mock Co',
      displayName: 'ada',
      email: null
    })
    saveWorkspaceToken('org-mock-1', 'mock-linear-key-1')

    expect(await call('linear.agentSearchIssues', search)).toMatchObject({
      ok: false,
      error: { code: 'linear_unavailable' }
    })
    expect(await call('linear.setAgentAccess', { enabled: true })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(runtime.linearSearchForAgents).not.toHaveBeenCalled()

    expect(await call('linear.setAgentAccess', { enabled: true }, fromPodNative)).toMatchObject({
      ok: true,
      result: { agentAccess: true }
    })
    expect(await call('linear.agentSearchIssues', search)).toMatchObject({ ok: true })
    expect(runtime.linearSearchForAgents).toHaveBeenCalledTimes(1)
    expect(await runtime.linearSearchForAgents.mock.results[0]?.value).toMatchObject({
      inAgentScope: true
    })
  })
})
