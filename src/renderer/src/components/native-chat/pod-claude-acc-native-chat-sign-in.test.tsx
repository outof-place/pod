// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { useNativeChatClaudeSignIn } from './native-chat-claude-sign-in'

let pod = true
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const reauthenticate = vi.fn()
const add = vi.fn(async () => ({
  ok: true,
  message: '',
  cancelled: false,
  state: { available: true, generatedAt: 1, accounts: [], podSelected: null }
}))

vi.mock('../settings/pod-claude-acc-accounts-section', () => ({
  isPodClaudeAccAccounts: () => pod
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const LOCAL = { kind: 'local' } as const

beforeEach(() => {
  vi.clearAllMocks()
  pod = true
  // System default: claude-acc's login, no Pod selection.
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), activeClaudeManagedAccountId: null },
    fetchSettings: vi.fn(() => Promise.resolve())
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { claudeAccounts: { reauthenticate }, podClaudeAcc: { add } }
  })
})
afterEach(cleanup)

describe("Pod's Claude chat sign-in", () => {
  it('runs claude-acc add for a local Claude chat, never a Pod profile sign-in', async () => {
    const failure = {}
    const { result } = renderHook(() =>
      useNativeChatClaudeSignIn({ agent: 'claude', target: LOCAL, failure, failureRows: 0 })
    )
    expect(result.current).not.toBeNull()
    await act(async () => result.current?.signIn())
    expect(add).toHaveBeenCalledOnce()
    expect(reauthenticate).not.toHaveBeenCalled()
    // Signed in: the chat's Retry follows, not another sign-in.
    expect(result.current).toBeNull()
  })

  it('says why claude-acc could not add the account, and keeps offering it', async () => {
    add.mockResolvedValueOnce({
      ok: false,
      message: 'browser closed',
      cancelled: false,
      state: { available: true, generatedAt: 1, accounts: [], podSelected: null }
    })
    const failure = {}
    const { result } = renderHook(() =>
      useNativeChatClaudeSignIn({ agent: 'claude', target: LOCAL, failure, failureRows: 0 })
    )
    await act(async () => result.current?.signIn())
    expect(toastError).toHaveBeenCalledWith('Claude sign-in failed.', {
      description: 'browser closed'
    })
    expect(result.current).not.toBeNull()
  })

  it('offers nothing for Codex or a remote chat', () => {
    const args = { failure: null, failureRows: 0 }
    expect(
      renderHook(() => useNativeChatClaudeSignIn({ ...args, agent: 'codex', target: LOCAL })).result
        .current
    ).toBeNull()
    const remote = { kind: 'environment', environmentId: 'env-1' } as const
    expect(
      renderHook(() => useNativeChatClaudeSignIn({ ...args, agent: 'claude', target: remote }))
        .result.current
    ).toBeNull()
  })

  it('keeps Orca’s System default without an offer outside Pod', () => {
    pod = false
    expect(
      renderHook(() =>
        useNativeChatClaudeSignIn({ agent: 'claude', target: LOCAL, failure: null, failureRows: 0 })
      ).result.current
    ).toBeNull()
  })
})
