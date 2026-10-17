import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fromFrameMock, getRendererContextForGuestMock } = vi.hoisted(() => ({
  fromFrameMock: vi.fn(),
  getRendererContextForGuestMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromFrame: fromFrameMock }
}))

vi.mock('../../browser/browser-manager', () => ({
  browserManager: { getRendererContextForGuest: getRendererContextForGuestMock }
}))

import { requestBrowserWebAuthnAccount } from '../../browser/browser-webauthn-account-picker'
import { setPodBrowserPaneHooks } from './pod-browser-pane-hooks'
import {
  PANE_PASSKEY_MAX_ACCOUNTS,
  PANE_PASSKEY_MAX_CREDENTIAL_ID,
  PANE_PASSKEY_TIMEOUT_MS,
  PanePasskeys
} from './pod-browser-pane-passkeys'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import {
  encodePodUiHostServerMessage,
  POD_UI_HOST_MAX_LINE_BYTES
} from '../ui-host/pod-ui-host-protocol'

const accounts = [
  { credentialId: 'credential-1', displayName: 'Personal', name: 'me@example.com' },
  { credentialId: 'credential-2', name: 'me@work.example' }
]

function setup(sendResult = true) {
  const sent: PodBrowserPaneServerMessage[] = []
  const passkeys = new PanePasskeys((message) => {
    sent.push(message)
    return sendResult
  })
  return { passkeys, sent }
}

function lastRequestId(sent: PodBrowserPaneServerMessage[]): string {
  const request = sent.findLast((message) => message.type === 'browserPasskeyAccounts')
  if (!request) {
    throw new Error('no browserPasskeyAccounts sent')
  }
  return request.requestId
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  setPodBrowserPaneHooks(null)
  vi.useRealTimers()
})

describe('PanePasskeys', () => {
  it('asks PodNative and resolves with the account it picked', async () => {
    const { passkeys, sent } = setup()
    const pick = passkeys.request('page-1', 'accounts.example.com', accounts)
    expect(sent).toEqual([
      {
        type: 'browserPasskeyAccounts',
        pageId: 'page-1',
        requestId: expect.any(String),
        relyingPartyId: 'accounts.example.com',
        accounts
      }
    ])
    expect(passkeys.choose('page-1', lastRequestId(sent), 'credential-2')).toBe(true)
    await expect(pick).resolves.toBe('credential-2')
    // Answered: no closing line, and a second answer finds nothing.
    expect(sent).toHaveLength(1)
    expect(passkeys.choose('page-1', lastRequestId(sent), 'credential-1')).toBe(false)
  })

  it('takes only an id it showed, for the page it asked about', async () => {
    const { passkeys, sent } = setup()
    const pick = passkeys.request('page-1', 'accounts.example.com', accounts)
    const requestId = lastRequestId(sent)
    expect(passkeys.choose('page-1', requestId, 'credential-9')).toBe(false)
    expect(passkeys.choose('page-2', requestId, 'credential-1')).toBe(false)
    expect(passkeys.choose('page-1', requestId, null)).toBe(true)
    await expect(pick).resolves.toBeNull()
  })

  it('ends without an account on a timeout, a closed page and a gone PodNative, and says so', async () => {
    const { passkeys, sent } = setup()
    const timedOut = passkeys.request('page-1', 'example.com', accounts)
    const first = lastRequestId(sent)
    vi.advanceTimersByTime(PANE_PASSKEY_TIMEOUT_MS)
    await expect(timedOut).resolves.toBeNull()
    expect(sent).toContainEqual({ type: 'browserPasskeyClosed', pageId: 'page-1', requestId: first })

    const closed = passkeys.request('page-1', 'example.com', accounts)
    const other = passkeys.request('page-2', 'example.com', accounts)
    passkeys.cancelPage('page-1')
    await expect(closed).resolves.toBeNull()
    passkeys.cancelAll()
    await expect(other).resolves.toBeNull()
    expect(sent.filter((message) => message.type === 'browserPasskeyClosed')).toHaveLength(3)
  })

  it('ends at once when the line could not go out', async () => {
    const { passkeys } = setup(false)
    await expect(passkeys.request('page-1', 'example.com', accounts)).resolves.toBeNull()
  })

  it('fits the worst request on one line: ids whole or skipped, labels cut well-formed', async () => {
    const { passkeys, sent } = setup()
    const label = `${'\u0001'.repeat(300)}\ud800`
    const many = Array.from({ length: PANE_PASSKEY_MAX_ACCOUNTS + 5 }, (_, index) => ({
      credentialId: String(index).padStart(PANE_PASSKEY_MAX_CREDENTIAL_ID, 'x'),
      displayName: label,
      name: label
    }))
    void passkeys.request('page-1', 'example.com', [
      { credentialId: 'y'.repeat(PANE_PASSKEY_MAX_CREDENTIAL_ID + 1) },
      ...many
    ])
    const request = sent[0]
    if (request?.type !== 'browserPasskeyAccounts') {
      throw new Error('no browserPasskeyAccounts sent')
    }
    expect(request.accounts).toHaveLength(PANE_PASSKEY_MAX_ACCOUNTS)
    expect(request.accounts[0].credentialId).toBe(many[0].credentialId)
    expect(request.accounts[0].name).toHaveLength(128)
    expect(request.accounts[0].name?.isWellFormed()).toBe(true)
    expect(Buffer.byteLength(encodePodUiHostServerMessage(request))).toBeLessThanOrEqual(
      POD_UI_HOST_MAX_LINE_BYTES
    )
    const lone = setup()
    void lone.passkeys.request('page-1', 'example.com', [
      { credentialId: 'c', displayName: 'a\ud800' }
    ])
    expect(lone.sent[0]).toMatchObject({ accounts: [{ credentialId: 'c', displayName: 'a\ufffd' }] })
  })

  it('asks nobody about a key with no account it could send back', async () => {
    const { passkeys, sent } = setup()
    const tooLong = { credentialId: 'y'.repeat(PANE_PASSKEY_MAX_CREDENTIAL_ID + 1) }
    await expect(passkeys.request('page-1', 'example.com', [tooLong])).resolves.toBeNull()
    expect(sent).toEqual([])
  })
})

describe('the WebAuthn account picker in one-app', () => {
  const guest = { id: 41, isDestroyed: () => false }
  const details = {
    relyingPartyId: 'accounts.example.com',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker only hands the frame to the mocked fromFrame.
    frame: {} as Electron.WebFrameMain,
    accounts
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane path never reads the session.
  const session = {} as Electron.Session

  beforeEach(() => {
    fromFrameMock.mockReset().mockReturnValue(guest)
    getRendererContextForGuestMock.mockReset().mockReturnValue(undefined)
  })

  it("asks the native pane for a page no renderer hosts, and resolves with the pane's pick", async () => {
    const passkey = vi.fn(async () => 'credential-1')
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: vi.fn(),
      openLink: vi.fn(() => false),
      passkey
    })
    await expect(requestBrowserWebAuthnAccount(details, session)).resolves.toBe('credential-1')
    expect(passkey).toHaveBeenCalledWith(41, 'accounts.example.com', accounts)
  })

  it('resolves without an account as before when no pane shows the page, or outside one-app', async () => {
    await expect(requestBrowserWebAuthnAccount(details, session)).resolves.toBeNull()
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: vi.fn(),
      openLink: vi.fn(() => false),
      passkey: () => null
    })
    await expect(requestBrowserWebAuthnAccount(details, session)).resolves.toBeNull()
  })
})
