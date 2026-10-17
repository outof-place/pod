// Fork-only (Pod): a security key's account picker for one-app's offscreen pages. Upstream asks the
// renderer that hosts the page (browser-webauthn-account-picker.ts); no renderer hosts these, so
// PodNative shows the accounts (browserPasskeyAccounts, the welcome's browserPasskey feature) and
// its pick comes back as browserPasskeyChoose. The labels are the site's text. Electron-free so it
// is testable on its own.
import { randomUUID } from 'node:crypto'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'

// As upstream's picker: a key's request doesn't wait longer.
export const PANE_PASSKEY_TIMEOUT_MS = 60_000
// Why: one ui-host line (64 KiB, past which PodNative drops the channel) holds the worst case, ~45 KB.
export const PANE_PASSKEY_MAX_ACCOUNTS = 20
export const PANE_PASSKEY_MAX_CREDENTIAL_ID = 512
const MAX_LABEL = 128

export type PanePasskeyAccount = { credentialId: string; displayName?: string; name?: string }

type Pending = {
  pageId: string
  credentialIds: Set<string>
  timer: ReturnType<typeof setTimeout>
  settle: (credentialId: string | null) => void
}

// Why well-formed: a lone surrogate encodes as \udXXX, which PodNative's JSONSerialization refuses.
function label(text: string | undefined): string | undefined {
  const cut = text?.trim().slice(0, MAX_LABEL).toWellFormed()
  return cut ? cut : undefined
}

export class PanePasskeys {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly send: (message: PodBrowserPaneServerMessage) => boolean) {}

  /** PodNative's pick among a page's accounts: a credential id, or null (none, closed, timed out). */
  request(
    pageId: string,
    relyingPartyId: string,
    accounts: readonly PanePasskeyAccount[]
  ): Promise<string | null> {
    // Why skip, not cut: a credential id has to come back whole.
    const shown = accounts
      .filter((account) => account.credentialId.length <= PANE_PASSKEY_MAX_CREDENTIAL_ID)
      .slice(0, PANE_PASSKEY_MAX_ACCOUNTS)
    if (shown.length === 0) {
      return Promise.resolve(null)
    }
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const settle = (credentialId: string | null): void => {
        const request = this.pending.get(requestId)
        if (!request) {
          return
        }
        clearTimeout(request.timer)
        this.pending.delete(requestId)
        if (credentialId === null) {
          // Why: a sheet PodNative still shows would answer a request that is gone.
          this.send({ type: 'browserPasskeyClosed', pageId, requestId })
        }
        resolve(credentialId)
      }
      const timer = setTimeout(() => settle(null), PANE_PASSKEY_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, {
        pageId,
        credentialIds: new Set(shown.map((account) => account.credentialId)),
        timer,
        settle
      })
      const sent = this.send({
        type: 'browserPasskeyAccounts',
        pageId,
        requestId,
        relyingPartyId: label(relyingPartyId) ?? '',
        accounts: shown.map((account) => {
          const displayName = label(account.displayName)
          const name = label(account.name)
          return {
            credentialId: account.credentialId,
            ...(displayName ? { displayName } : {}),
            ...(name ? { name } : {})
          }
        })
      })
      if (!sent) {
        settle(null)
      }
    })
  }

  /** PodNative's answer: only for a request of that page, and only one of the ids it was shown. */
  choose(pageId: string, requestId: string, credentialId: string | null): boolean {
    const request = this.pending.get(requestId)
    if (
      !request ||
      request.pageId !== pageId ||
      (credentialId !== null && !request.credentialIds.has(credentialId))
    ) {
      return false
    }
    request.settle(credentialId)
    return true
  }

  /** The page went away: its requests end without an account. */
  cancelPage(pageId: string): void {
    for (const request of this.pending.values()) {
      if (request.pageId === pageId) {
        request.settle(null)
      }
    }
  }

  /** PodNative went away: nobody is left to pick. */
  cancelAll(): void {
    for (const request of this.pending.values()) {
      request.settle(null)
    }
  }
}
