import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import type { Store } from '../../persistence'
import { PodSettingsService } from './pod-settings-service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

function service(store: Store): PodSettingsService {
  // The store's own write, which settings:set's path ends in.
  return new PodSettingsService(store, (values) =>
    store.updateSettingsAndFlush(values, { notifyListeners: true })
  )
}

/** What a restarted runtime reads from disk. */
async function reopen(): Promise<Store> {
  await closeTestStores()
  return createStore()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'pod-settings-store-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('podSettings writes on a real profile', () => {
  it("turns source control's AI on without losing its agent or recipes", async () => {
    const store = createStore()
    const fixChecks = { agentId: 'codex' as const, commandInputTemplate: 'Fix {checks}' }
    store.updateSettings({
      sourceControlAi: {
        ...store.getSettings().sourceControlAi!,
        agentId: 'codex',
        actions: { fixChecks }
      }
    })
    const settings = service(store)
    const result = await settings.set(
      { sourceControlAi: { enabled: true } },
      settings.get().revision
    )
    expect(result.ok).toBe(true)

    const reopened = await reopen()
    expect(reopened.getSettings().sourceControlAi).toMatchObject({
      enabled: true,
      agentId: 'codex',
      actions: expect.objectContaining({ fixChecks })
    })
    // Orca's legacy key follows, as when Pod's own window turns it on.
    expect(reopened.getSettings().commitMessageAi).toMatchObject({ enabled: true })
    expect(service(reopened).get().readOnly.sourceControlAi).toEqual({ enabled: true })
  })

  it('keeps Open In apps, overrides and the proxy bypass across a restart', async () => {
    const store = createStore()
    const settings = service(store)
    const openInApplications = [
      { id: 'vscode', label: 'VS Code', command: 'code' },
      { id: 'zed', label: 'Zed', command: 'zed' }
    ]
    const result = await settings.set(
      {
        openInApplications,
        agentCmdOverrides: { codex: 'codex --profile work' },
        httpProxyBypassRules: 'localhost;*.internal',
        terminalScrollSensitivity: 2.5,
        experimentalAgentHibernation: true
      },
      settings.get().revision
    )
    expect(result.ok).toBe(true)

    const values = service(await reopen()).get().values
    expect(values).toMatchObject({
      openInApplications,
      agentCmdOverrides: { codex: 'codex --profile work' },
      httpProxyBypassRules: 'localhost;*.internal',
      terminalScrollSensitivity: 2.5,
      experimentalAgentHibernation: true
    })
  })

  it('stores the proxy URL encrypted and reads it back for this machine', async () => {
    const store = createStore()
    await service(store).setNetworkProxy('http://user:hunter2@proxy.example.invalid:3128')
    const reopened = await reopen()
    expect(service(reopened).networkProxy().httpProxyUrl).toBe(
      'http://user:hunter2@proxy.example.invalid:3128'
    )
    expect(JSON.stringify(service(reopened).get())).not.toContain('hunter2')
  })
})
