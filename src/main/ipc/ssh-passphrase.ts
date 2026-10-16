import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { SSH_CREDENTIAL_TIMEOUT_MS, type SshCredentialKind } from '../ssh/ssh-connection-utils'
import { podSshCredentialHub } from '../pod/ssh/pod-ssh-credential-hub'
import type { PodSshCredentialSettleReason } from '../../shared/pod-ssh-credential-event'
const pendingRequests = new Map<string, { resolve: (value: string | null) => void }>()

function notifyCredentialResolved(
  getMainWindow: () => BrowserWindow | null,
  requestId: string
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-resolved', { requestId })
  }
}

export function requestCredential(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  kind: SshCredentialKind,
  detail: string,
  echo?: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const requestId = randomUUID()
  const { promise, resolve } = Promise.withResolvers<string | null>()
  let timer: ReturnType<typeof setTimeout>
  const finish = (
    value: string | null,
    reason: PodSshCredentialSettleReason = value === null ? 'cancelled' : 'submitted'
  ): void => {
    if (!pendingRequests.delete(requestId)) {
      return
    }
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    notifyCredentialResolved(getMainWindow, requestId)
    podSshCredentialHub.settle(requestId, reason)
    resolve(value)
  }
  const onAbort = (): void => finish(null, 'aborted')
  const expiresAtMs = Date.now() + SSH_CREDENTIAL_TIMEOUT_MS
  timer = setTimeout(() => finish(null, 'timeout'), SSH_CREDENTIAL_TIMEOUT_MS)
  pendingRequests.set(requestId, { resolve: finish })
  if (signal?.aborted) {
    finish(null, 'aborted')
    return promise
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  // Fork-only (Pod): PodNative may answer too; a windowless one-app host has only it to ask.
  const podListens = podSshCredentialHub.ask(
    { requestId, targetId, kind, detail, echo, expiresAtMs },
    finish
  )
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail, echo })
  } else if (!podListens) {
    finish(null)
  }
  return promise
}

export function registerCredentialHandler(): void {
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => {
      pendingRequests.get(args.requestId)?.resolve(args.value)
    }
  )
}
