// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PodClaudeAccAccount,
  PodClaudeAccResult,
  PodClaudeAccState
} from '../../../../shared/pod-claude-acc-accounts'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

let pod = true
const selectClaudeProviderAccount = vi.fn()
const fetchProviderAccountsSnapshot = vi.fn(async () => ({
  claude: {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  },
  codex: { accounts: [], activeAccountId: null },
  failedProviders: []
}))
const toastError = vi.fn()

function row(email: string, extra: Partial<PodClaudeAccAccount> = {}): PodClaudeAccAccount {
  return {
    email,
    active: false,
    usable: true,
    needsSignIn: false,
    podProfile: false,
    note: null,
    session: null,
    weekly: null,
    ...extra
  }
}

const state: PodClaudeAccState = {
  available: true,
  generatedAt: 1,
  accounts: [
    row('a@example.com', { active: true }),
    row('b@example.com'),
    row('c@example.com', { needsSignIn: true }),
    row('profile@example.com', { podProfile: true, usable: false })
  ],
  podSelected: null
}

function result(ok = true): PodClaudeAccResult {
  return { ok, message: ok ? '' : 'nope', cancelled: false, state }
}

const podClaudeAcc = {
  list: vi.fn(async () => state),
  add: vi.fn(async () => result()),
  signInAgain: vi.fn(async (_email: string) => result()),
  switchTo: vi.fn(async (_email: string) => result()),
  cancel: vi.fn(async () => false)
}
const claudeAccounts = { select: vi.fn(), reauthenticate: vi.fn(), add: vi.fn() }

vi.mock('../settings/pod-claude-acc-accounts-section', () => ({
  isPodClaudeAccAccounts: () => pod
}))
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ getActiveRuntimeTarget: () => null }))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
vi.mock('./tooltip', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ProviderIcon: () => null,
  ProviderPanel: () => null
}))
// Why: Radix portals its menu behind pointer-capture the DOM shim cannot drive.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough =
    (role?: string) =>
    ({
      children,
      onSelect,
      disabled
    }: {
      children?: React.ReactNode
      onSelect?: (event: { preventDefault: () => void }) => void
      disabled?: boolean
    }): React.JSX.Element =>
      React.createElement(
        'div',
        {
          role,
          'aria-disabled': disabled ? 'true' : undefined,
          onClick: onSelect && !disabled ? () => onSelect({ preventDefault: () => {} }) : undefined
        },
        children
      )
  return {
    DropdownMenu: passthrough(),
    DropdownMenuCheckboxItem: passthrough(),
    DropdownMenuContent: passthrough(),
    DropdownMenuItem: passthrough('menuitem'),
    DropdownMenuLabel: passthrough(),
    DropdownMenuSeparator: passthrough(),
    DropdownMenuSub: passthrough(),
    DropdownMenuSubContent: passthrough(),
    DropdownMenuSubTrigger: passthrough(),
    DropdownMenuTrigger: passthrough()
  }
})
vi.mock('../../store', () => {
  const store = (): Record<string, unknown> => ({
    settings: null,
    runtimeEnvironments: [],
    usagePercentageDisplay: 'used',
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshClaudeRateLimitsForTarget: vi.fn(),
    fetchInactiveClaudeAccountUsage: vi.fn(),
    rateLimits: { inactiveClaudeAccounts: [], claudeTarget: { runtime: 'host', wslDistro: null } }
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(store())
  useAppStore.getState = store
  return { useAppStore }
})

const claudeProvider: ProviderRateLimits = {
  provider: 'claude',
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1
}

async function openSwitcher(): Promise<void> {
  const { ClaudeSwitcherMenu } = await import('./ClaudeSwitcherMenu')
  render(
    React.createElement(ClaudeSwitcherMenu, {
      claude: claudeProvider,
      compact: false,
      iconOnly: false
    })
  )
  fireEvent.click(await screen.findByText('a@example.com'))
  await screen.findByText('b@example.com')
}

describe("Pod's status-bar Claude switcher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pod = true
    Object.assign(window, { api: { podClaudeAcc, claudeAccounts } })
  })

  afterEach(() => {
    cleanup()
  })

  it("lists claude-acc's own accounts, never a Pod profile", async () => {
    // Why imported here: vi.mock factories read this file's mocks, set up only after hoisting.
    const { podClaudeAccSwitchRows } = await import('./pod-claude-acc-switcher-menu')
    expect(podClaudeAccSwitchRows(state).map((account) => account.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com'
    ])
    expect(podClaudeAccSwitchRows(null)).toEqual([])
  })

  it('switches through claude-acc and stores no Pod selection', async () => {
    await openSwitcher()
    expect(screen.queryByText('profile@example.com')).toBeNull()
    fireEvent.click(screen.getByText('b@example.com'))
    await waitFor(() => expect(podClaudeAcc.switchTo).toHaveBeenCalledWith('b@example.com'))
    expect(selectClaudeProviderAccount).not.toHaveBeenCalled()
    expect(fetchProviderAccountsSnapshot).not.toHaveBeenCalled()
    expect(claudeAccounts.select).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('signs an account in again through claude-acc', async () => {
    await openSwitcher()
    fireEvent.click(screen.getByText('c@example.com'))
    await waitFor(() => expect(podClaudeAcc.signInAgain).toHaveBeenCalledWith('c@example.com'))
    expect(podClaudeAcc.switchTo).not.toHaveBeenCalled()
    expect(claudeAccounts.reauthenticate).not.toHaveBeenCalled()
  })

  it('says why claude-acc refused a switch', async () => {
    podClaudeAcc.switchTo.mockResolvedValueOnce(result(false))
    await openSwitcher()
    fireEvent.click(screen.getByText('b@example.com'))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Claude account update failed.', {
        description: 'nope'
      })
    )
  })

  it('keeps Orca’s own switcher outside Pod', async () => {
    pod = false
    const { ClaudeSwitcherMenu } = await import('./ClaudeSwitcherMenu')
    render(
      React.createElement(ClaudeSwitcherMenu, {
        claude: claudeProvider,
        compact: false,
        iconOnly: false
      })
    )
    await waitFor(() => expect(fetchProviderAccountsSnapshot).toHaveBeenCalled())
    expect(podClaudeAcc.list).not.toHaveBeenCalled()
  })
})
