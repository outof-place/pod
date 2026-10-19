// Fork-only (Pod): while Linear is off (compiled out, podLinear off, or no SDK), linear.status says
// why and every other linear.* method answers linear_unavailable, for every caller.
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcRequest } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatcher-stream-options'
import { LOCAL_CLI_RPC_CALLER } from '../../runtime/rpc/rpc-caller-identity'
import { OWNER_RPC_CALLER_SCOPE } from '../../runtime/rpc/rpc-caller-scope'
import { LINEAR_METHODS } from '../../runtime/rpc/methods/linear'
import { installPodLinear } from './install-pod-linear'
import { podLinearRpcRefusal, setPodLinearAgentAccessSetting } from './pod-linear-access'
import {
  podLinearAvailability,
  podLinearUnavailableMessage,
  setPodLinearEnabledSetting
} from './pod-linear-availability'
import { setTestUserData } from './pod-linear-key-store.test-support'
import { POD_LINEAR_METHODS } from './pod-linear-rpc-methods'

const ON = { read: () => true, write: () => {} }
const cli = { scope: OWNER_RPC_CALLER_SCOPE, identity: LOCAL_CLI_RPC_CALLER }

afterEach(() => {
  setPodLinearEnabledSetting(null)
  setPodLinearAgentAccessSetting(null)
})

describe('podLinearAvailability', () => {
  it('needs the build feature, the setting and the SDK, and names the first that is missing', () => {
    const sdk = () => true
    expect(podLinearAvailability(false, sdk)).toEqual({ available: false, reason: 'feature-off' })
    expect(podLinearAvailability(true, sdk)).toEqual({ available: false, reason: 'setting-off' })
    setPodLinearEnabledSetting(ON)
    expect(podLinearAvailability(true, () => false)).toEqual({
      available: false,
      reason: 'sdk-missing'
    })
    expect(podLinearAvailability(true, sdk)).toEqual({ available: true })
  })

  it('finds the SDK this checkout installs', () => {
    setPodLinearEnabledSetting(ON)
    expect(podLinearAvailability()).toEqual({ available: true })
  })
})

describe('while Linear is off', () => {
  it('answers linear_unavailable for every method but the status and the two switches', () => {
    setPodLinearAgentAccessSetting(ON)
    for (const method of ['linear.searchIssues', 'linear.testConnection', 'linear.issueContext']) {
      expect(podLinearRpcRefusal(method, cli)).toEqual({
        code: 'linear_unavailable',
        message: podLinearUnavailableMessage('setting-off')
      })
    }
    expect(podLinearRpcRefusal('linear.status', cli)).toBeNull()
    expect(podLinearRpcRefusal('worktree.list', cli)).toBeNull()
    // The switches stay admin methods: off or on, the owner token alone can't flip them.
    expect(podLinearRpcRefusal('linear.setEnabled', cli)).toMatchObject({ code: 'forbidden' })
  })

  it('reports why in linear.status without reading any Linear file', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'pod-linear-off-'))
    setTestUserData(userData)
    vi.resetModules()
    const linear = await import('../../linear/client')

    expect(linear.getStatus()).toEqual({
      connected: false,
      viewer: null,
      available: false,
      reason: 'setting-off',
      agentAccess: false
    })
    expect(existsSync(join(userData, 'integrations'))).toBe(false)
  })

  it('turns on through linear.setEnabled from PodNative, and then answers', async () => {
    let settings: { podLinear?: boolean } = {}
    installPodLinear({
      getSettings: () => settings,
      updateSettings: (updates) => {
        settings = { ...settings, ...updates }
      }
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearSearchIssues: vi.fn().mockResolvedValue([])
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods under test call only these runtime members.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: [...LINEAR_METHODS, ...POD_LINEAR_METHODS]
    })
    const fromPodNative: RpcDispatchStreamingOptions = {
      podNativePeer: () => ({ ok: true, pid: 4242 })
    }
    const call = (method: string, params: unknown) => {
      const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
      return dispatcher.dispatch(request, fromPodNative)
    }

    expect(await call('linear.searchIssues', { query: 'login' })).toMatchObject({
      ok: false,
      error: { code: 'linear_unavailable' }
    })
    expect(await call('linear.setEnabled', { enabled: true })).toMatchObject({
      ok: true,
      result: { enabled: true, available: true }
    })
    expect(settings.podLinear).toBe(true)
    expect(await call('linear.searchIssues', { query: 'login' })).toMatchObject({ ok: true })
    expect(runtime.linearSearchIssues).toHaveBeenCalledTimes(1)
  })
})
