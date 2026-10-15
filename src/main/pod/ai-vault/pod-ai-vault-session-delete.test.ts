import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcResponse } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { POD_AI_VAULT_METHODS } from '../../runtime/rpc/methods/pod-ai-vault-delete'
import { installPodAiVaultSessionDelete } from './install-pod-ai-vault-session-delete'
import { setPodAiVaultSessionDelete } from './pod-ai-vault-session-delete'

const { home, trashItem } = vi.hoisted(() => ({
  home: { dir: '' },
  trashItem: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof Os>()
  return { ...os, default: { ...os, homedir: () => home.dir }, homedir: () => home.dir }
})

vi.mock('electron', () => ({
  app: { getPath: () => home.dir, on: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { trashItem }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

function deleteSession(params: unknown): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime, methods: POD_AI_VAULT_METHODS }).dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'aiVault.deleteSession',
    params
  })
}

let projects: string

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  home.dir = realpathSync(mkdtempSync(join('/tmp', 'pod-ai-vault-delete-')))
  projects = join(home.dir, '.claude', 'projects', '-Users-me-app')
  mkdirSync(projects, { recursive: true })
  // The Trash, as far as the test can tell: the file leaves its folder.
  trashItem.mockImplementation(async (path: string) => rmSync(path, { recursive: true }))
  installPodAiVaultSessionDelete()
})

afterEach(() => {
  setPodAiVaultSessionDelete(null)
  rmSync(home.dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('aiVault.deleteSession on real files', () => {
  it("moves a Claude session's log to the Trash", async () => {
    const log = join(projects, 'session-1.jsonl')
    writeFileSync(log, '{}\n')

    const response = await deleteSession({ agent: 'claude', filePath: log, sessionId: 'session-1' })

    expect(response).toMatchObject({ ok: true, result: { outcome: 'deleted' } })
    expect(trashItem).toHaveBeenCalledWith(log)
    expect(existsSync(log)).toBe(false)
  })

  it('keeps a file outside the agent folders and says why', async () => {
    const elsewhere = join(home.dir, 'notes', 'session-1.jsonl')
    mkdirSync(join(home.dir, 'notes'))
    writeFileSync(elsewhere, '{}\n')

    const response = await deleteSession({ agent: 'claude', filePath: elsewhere })

    expect(response).toMatchObject({
      ok: true,
      result: { outcome: 'rejected', reason: 'path-outside-known-roots' }
    })
    expect(existsSync(elsewhere)).toBe(true)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it("keeps a local file that shares a path with another host's session", async () => {
    const log = join(projects, 'session-2.jsonl')
    writeFileSync(log, '{}\n')

    const response = await deleteSession({
      agent: 'claude',
      filePath: log,
      executionHostId: 'ssh:other-mac'
    })

    expect(response).toMatchObject({ ok: true, result: { reason: 'non-local-host' } })
    expect(existsSync(log)).toBe(true)
  })
})
