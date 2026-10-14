import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  clearPodClaudeHostSelection,
  podDropClaudeHostSelection
} from './pod-claude-host-selection'

const profile: ClaudeManagedAccount = {
  id: 'p1',
  email: 'p1@example.test',
  managedAuthPath: '/data/claude-profiles/p1/home',
  managedAuthRuntime: 'host',
  wslDistro: null,
  authMethod: 'subscription-oauth',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

function fixture(selection: Partial<GlobalSettings> = {}) {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: [profile],
    ...selection
  }
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: Partial<GlobalSettings>) => {
      settings = { ...settings, ...patch }
    })
  }
  return { store, settings: () => settings }
}

describe("Pod's stored Claude host selection", () => {
  it('clears a stored host selection once in Pod, keeping WSL picks and the profiles', () => {
    const f = fixture({
      activeClaudeManagedAccountId: 'p1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'p1', wsl: { Ubuntu: 'w1' } }
    })
    const log = vi.fn()
    expect(clearPodClaudeHostSelection(f.store, true, log)).toBe(true)
    expect(f.settings().activeClaudeManagedAccountId).toBeNull()
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime).toEqual({
      host: null,
      wsl: { Ubuntu: 'w1' }
    })
    expect(f.settings().claudeManagedAccounts).toEqual([profile])
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toContain('host p1, legacy p1')
    // The next start finds nothing to clear and writes nothing.
    expect(clearPodClaudeHostSelection(f.store, true, log)).toBe(false)
    expect(f.store.updateSettings).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
  })

  it('clears a legacy-only selection, and never runs outside Pod', () => {
    const legacy = fixture({ activeClaudeManagedAccountId: 'p1' })
    expect(clearPodClaudeHostSelection(legacy.store, true, vi.fn())).toBe(true)
    expect(legacy.settings().activeClaudeManagedAccountId).toBeNull()
    const upstream = fixture({
      activeClaudeManagedAccountId: 'p1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'p1', wsl: {} }
    })
    expect(clearPodClaudeHostSelection(upstream.store, false, vi.fn())).toBe(false)
    expect(upstream.store.updateSettings).not.toHaveBeenCalled()
  })

  it('drops a host selection from a generic settings write in Pod, keeping WSL picks, and logs once', () => {
    const log = vi.fn()
    const write = {
      theme: 'dark' as const,
      activeClaudeManagedAccountId: 'p1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'p1', wsl: { Ubuntu: 'w1' } }
    }
    expect(podDropClaudeHostSelection(write, true, log)).toEqual({
      theme: 'dark',
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'w1' } }
    })
    expect(podDropClaudeHostSelection({ activeClaudeManagedAccountId: 'p2' }, true, log)).toEqual(
      {}
    )
    expect(log).toHaveBeenCalledOnce()
    const other = { theme: 'light' as const }
    expect(podDropClaudeHostSelection(other, true, log)).toBe(other)
    expect(podDropClaudeHostSelection(write, false, log)).toBe(write)
    expect(log).toHaveBeenCalledOnce()
  })
})
