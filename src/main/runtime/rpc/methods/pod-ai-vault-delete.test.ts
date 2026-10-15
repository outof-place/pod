import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setPodAiVaultSessionDelete } from '../../../pod/ai-vault/pod-ai-vault-session-delete'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import { POD_AI_VAULT_METHODS } from './pod-ai-vault-delete'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

function dispatch(params: unknown, options?: { pairedDeviceId?: string }): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime, methods: POD_AI_VAULT_METHODS }).dispatch(
    { id: 'req-1', authToken: 'tok', method: 'aiVault.deleteSession', params },
    options
  )
}

const row = { agent: 'claude', filePath: '/Users/me/.claude/projects/-x/session-1.jsonl' }

afterEach(() => {
  setPodAiVaultSessionDelete(null)
})

describe('aiVault.deleteSession', () => {
  it('is advertised, so a client shows Delete only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ai-vault.delete-session.v1')
  })

  it('declares host-admin: it destroys files, so no SSH host CLI may reach it', () => {
    expect(POD_AI_VAULT_METHODS.map((method) => [method.name, method.permission])).toEqual([
      ['aiVault.deleteSession', 'host-admin']
    ])
  })

  it("refuses an SSH host's orca CLI, even with remote control on, before anything is deleted", async () => {
    const remove = vi.fn()
    setPodAiVaultSessionDelete(remove)
    const bridge = new RpcDispatcher({
      runtime,
      methods: POD_AI_VAULT_METHODS,
      callerScope: { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl: true }
    })

    await expect(
      bridge.dispatch({
        id: 'req-1',
        authToken: 'tok',
        method: 'aiVault.deleteSession',
        params: row
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses a payload the IPC handler would have rejected', async () => {
    const remove = vi.fn()
    setPodAiVaultSessionDelete(remove)
    for (const params of [
      { ...row, agent: 'not-an-agent' },
      { ...row, filePath: '' },
      { agent: 'claude' },
      { ...row, extra: true }
    ]) {
      await expect(dispatch(params)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(remove).not.toHaveBeenCalled()
  })

  it("deletes this machine's log and answers with the delete's own outcome", async () => {
    const remove = vi.fn(async () => ({ outcome: 'deleted' as const }))
    setPodAiVaultSessionDelete(remove)

    await expect(dispatch({ ...row, sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { outcome: 'deleted' }
    })
    expect(remove).toHaveBeenCalledWith({
      ...row,
      sessionId: 'session-1',
      executionHostId: 'local'
    })
  })

  it("passes another host's row on, so the delete refuses it rather than a local namesake", async () => {
    const remove = vi.fn(async () => ({
      outcome: 'rejected' as const,
      agent: 'claude' as const,
      reason: 'non-local-host' as const
    }))
    setPodAiVaultSessionDelete(remove)

    await expect(dispatch({ ...row, executionHostId: 'ssh:box' })).resolves.toMatchObject({
      ok: true,
      result: { outcome: 'rejected', reason: 'non-local-host' }
    })
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ executionHostId: 'ssh:box' }))
  })

  it('refuses paired devices before anything is deleted', async () => {
    const remove = vi.fn()
    setPodAiVaultSessionDelete(remove)

    await expect(dispatch(row, { pairedDeviceId: 'phone-1' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('answers runtime_unavailable where no delete is installed', async () => {
    await expect(dispatch(row)).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
  })
})
