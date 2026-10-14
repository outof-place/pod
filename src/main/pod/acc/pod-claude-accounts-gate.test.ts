import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import {
  POD_CLAUDE_ACCOUNTS_MANAGED_CODE,
  POD_CLAUDE_ACCOUNTS_MANAGED_MESSAGE
} from '../../../shared/pod-claude-accounts-managed'
import { ClaudeAccountService } from '../../claude-accounts/service'
import { mapRuntimeError } from '../../runtime/rpc/errors'
import {
  podGuardClaudeAccounts,
  POD_REFUSED_CLAUDE_ACCOUNT_CALLS
} from './pod-claude-accounts-gate'

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
  const runtimeAuth = {
    router: {
      accountHome: (id: string) => `/data/claude-profiles/${id}/home`,
      userConfigDir: () => '/home/u/.claude',
      copiedLoginIntoSystemDefault: () => false,
      coveredBySystemDefault: () => true
    },
    syncForCurrentSelection: vi.fn(async () => {}),
    publishAll: vi.fn(async () => {}),
    prepareAccountFolder: vi.fn(async () => ({ configDir: '/x', readPath: '/x' })),
    removeAccountFolder: vi.fn(async () => {}),
    getRuntimeConfigDir: () => '/home/u/.claude'
  }
  const runLogin = vi.fn(async () => '')
  const service = new ClaudeAccountService(
    store,
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    runtimeAuth,
    runLogin
  )
  return { service, store, runtimeAuth, runLogin, settings: () => settings }
}

const signIn = { accountId: 'p1', runtime: 'host' as const }

function calls(service: ClaudeAccountService): Promise<unknown>[] {
  return [
    service.addAccount(),
    service.reauthenticateAccount('p1'),
    service.beginSignIn(),
    service.finishSignIn(signIn),
    service.cancelSignIn(signIn),
    service.removeAccount('p1'),
    service.selectAccount('p1'),
    service.selectAccountForTarget('p1', { runtime: 'host' })
  ]
}

describe("Pod's Claude account gate", () => {
  it('refuses every sign-in, select and remove in Pod, and touches no profile or setting', async () => {
    const f = fixture()
    const guarded = podGuardClaudeAccounts(f.service, true)
    const results = await Promise.allSettled(calls(guarded))
    expect(results).toHaveLength(POD_REFUSED_CLAUDE_ACCOUNT_CALLS.length)
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: {
          code: POD_CLAUDE_ACCOUNTS_MANAGED_CODE,
          message: POD_CLAUDE_ACCOUNTS_MANAGED_MESSAGE
        }
      })
    }
    expect(f.runLogin).not.toHaveBeenCalled()
    expect(f.runtimeAuth.prepareAccountFolder).not.toHaveBeenCalled()
    expect(f.runtimeAuth.removeAccountFolder).not.toHaveBeenCalled()
    expect(f.runtimeAuth.syncForCurrentSelection).not.toHaveBeenCalled()
    expect(f.store.updateSettings).not.toHaveBeenCalled()
    // Reads keep working: the profile row and the System default folder stay visible.
    expect(guarded.listAccounts().accounts.map((row) => row.id)).toEqual(['p1'])
    expect(guarded.getRuntimeConfigDir()).toBe('/home/u/.claude')
  })

  it('leaves upstream Orca (no product identity) as it is', async () => {
    const f = fixture()
    const service = podGuardClaudeAccounts(f.service, false)
    for (const name of POD_REFUSED_CLAUDE_ACCOUNT_CALLS) {
      expect(Object.hasOwn(service, name)).toBe(false)
    }
    await service.selectAccount('p1')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('p1')
  })

  it('reaches RPC clients as its own error code', async () => {
    const guarded = podGuardClaudeAccounts(fixture().service, true)
    const error = await guarded.beginSignIn().catch((reason: unknown) => reason)
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: {
        code: POD_CLAUDE_ACCOUNTS_MANAGED_CODE,
        message: POD_CLAUDE_ACCOUNTS_MANAGED_MESSAGE
      }
    })
  })
})
