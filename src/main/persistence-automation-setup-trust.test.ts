import { closeTestStores, testState, createStore, makeRepo } from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const BASE = {
  name: 'Nightly',
  prompt: 'Review',
  agentId: 'claude' as const,
  projectId: 'r1',
  workspaceMode: 'new_per_run' as const,
  workspaceId: null,
  baseBranch: 'main',
  setupDecision: 'run' as const,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: new Date('2026-05-13T00:00:00Z').getTime()
}
const HASH = 'a'.repeat(64)

describe('automation setup trust hash persistence (Pod)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps the approved hash of a new-per-run automation across a reload', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    expect(store.createAutomation({ ...BASE, setupTrustHash: HASH }).setupTrustHash).toBe(HASH)
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].setupTrustHash).toBe(HASH)
  })

  it('keeps none for an automation that reuses a workspace', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      ...BASE,
      workspaceMode: 'existing',
      workspaceId: 'r1::/tmp/r1',
      setupTrustHash: HASH
    })
    expect(Object.hasOwn(automation, 'setupTrustHash')).toBe(false)
  })

  it('preserves on omission, replaces, and clears with null', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, setupTrustHash: HASH })
    expect(store.updateAutomation(id, { name: 'Renamed' }).setupTrustHash).toBe(HASH)
    expect(store.updateAutomation(id, { setupTrustHash: 'b'.repeat(64) }).setupTrustHash).toBe(
      'b'.repeat(64)
    )
    expect(store.updateAutomation(id, { setupTrustHash: null }).setupTrustHash).toBeNull()
  })

  // What `orca automations edit --base-branch` sends: no hash, so none carries over to the new base.
  it('drops the hash when an update re-points the base, even to a ref with the same orca.yaml', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, setupTrustHash: HASH })
    const moved = store.updateAutomation(id, { baseBranch: 'fork/main' })
    expect(moved.baseBranch).toBe('fork/main')
    expect(moved.setupTrustHash).toBeNull()
    expect(store.updateAutomation(id, { baseBranch: 'main' }).setupTrustHash).toBeNull()
  })

  it('drops the hash on a repo or mode change', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.addRepo(makeRepo({ id: 'r2', path: '/tmp/r2' }))
    const first = store.createAutomation({ ...BASE, setupTrustHash: HASH })
    expect(store.updateAutomation(first.id, { projectId: 'r2' }).setupTrustHash).toBeNull()
    const second = store.createAutomation({ ...BASE, setupTrustHash: HASH })
    store.updateAutomation(second.id, { workspaceMode: 'existing', workspaceId: 'r1::/tmp/r1' })
    const back = store.updateAutomation(second.id, { workspaceMode: 'new_per_run' })
    expect(back.setupTrustHash).toBeNull()
  })

  it('keeps the hash an update brings with its new base, and the old one when the base is restated', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const { id } = store.createAutomation({ ...BASE, setupTrustHash: HASH })
    expect(
      store.updateAutomation(id, { baseBranch: 'main', name: 'Same base' }).setupTrustHash
    ).toBe(HASH)
    const fresh = 'c'.repeat(64)
    expect(
      store.updateAutomation(id, { baseBranch: 'release', setupTrustHash: fresh }).setupTrustHash
    ).toBe(fresh)
  })
})
