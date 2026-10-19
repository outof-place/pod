// @vitest-environment happy-dom
// Fork-only (Pod): the section's copy goes through translate with en.json keys; what it shows must
// stay the English it had inline, the paused-auto-switch sentence with its profile included.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PodClaudeAccAccount,
  PodClaudeAccState
} from '../../../../shared/pod-claude-acc-accounts'
import { PodClaudeAccAccountsSection } from './pod-claude-acc-accounts-section'

vi.mock('../../store', () => ({
  useAppStore: (select: (state: { settingsSearchQuery: string }) => unknown) =>
    select({ settingsSearchQuery: '' })
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

/** Renders once `list` has answered; `shown` is text only the answered state has. */
async function renderWith(state: PodClaudeAccState, shown: string): Promise<string> {
  const list = vi.fn(async () => state)
  vi.stubGlobal('api', { podClaudeAcc: { list } })
  const view = render(<PodClaudeAccAccountsSection />)
  await waitFor(() => expect(list).toHaveBeenCalled())
  await waitFor(() => expect(view.container.textContent).toContain(shown))
  return view.container.textContent ?? ''
}

describe('PodClaudeAccAccountsSection copy', () => {
  it('shows the same English as before, the profile inside the paused sentence', async () => {
    const text = await renderWith(
      {
        available: true,
        generatedAt: 1,
        accounts: [
          row('a@example.com', { active: true }),
          row('b@example.com'),
          row('c@example.com', { needsSignIn: true }),
          row('profile@example.com', { podProfile: true, usable: false })
        ],
        podSelected: 'pod@example.com'
      },
      'a@example.com'
    )
    for (const copy of [
      'Claude',
      'Claude accounts live in claude-acc, the same list as Pod Menu. Every account here is in auto-switch, and a switch moves the Claude login your sessions use.',
      'Accounts',
      'Add Account opens claude.ai in your browser.',
      'Add Account',
      'Auto-switch is paused: Pod has pod@example.com selected for new Claude sessions. Choose System default in the Claude menu of the status bar to hand switching back to claude-acc.',
      'Active',
      'Pod profile · usage only',
      'Sign in again to use this account',
      'Switch',
      'Sign in again'
    ]) {
      expect(text).toContain(copy)
    }
  })

  it('shows the same empty-list sentences as before', async () => {
    const empty =
      'No Claude accounts yet. Add one, or sign in with /login in a Claude session: claude-acc takes that login over within 2 minutes.'
    expect(
      await renderWith({ available: true, generatedAt: 1, accounts: [], podSelected: null }, empty)
    ).toContain(empty)
    cleanup()
    const notChecked =
      "claude-acc hasn't checked accounts yet. It comes with Pod and checks every 2 minutes."
    const text = await renderWith(
      { available: false, generatedAt: null, accounts: [], podSelected: null },
      notChecked
    )
    expect(text).toContain(notChecked)
    expect(text).not.toContain('Auto-switch is paused')
  })
})
