import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { requestCredential } from './ssh-passphrase'
import { SSH_CREDENTIAL_TIMEOUT_MS } from '../ssh/ssh-connection-utils'
import { podSshCredentialHub } from '../pod/ssh/pod-ssh-credential-hub'
import type { PodSshCredentialEvent } from '../../shared/pod-ssh-credential-event'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

function credentialWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('SSH credential requests', () => {
  it('resolves and removes the renderer prompt when its connection aborts', async () => {
    const window = credentialWindow()
    const controller = new AbortController()
    const pending = requestCredential(
      () => window,
      'target-1',
      'keyboard-interactive',
      'Duo response',
      undefined,
      controller.signal
    )
    const request = vi.mocked(window.webContents.send).mock.calls[0][1] as { requestId: string }

    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(window.webContents.send).toHaveBeenLastCalledWith('ssh:credential-resolved', {
      requestId: request.requestId
    })
  })

  it('cancels at once on a host with no window and no Pod client, as before', async () => {
    await expect(
      requestCredential(() => null, 'target-1', 'password', 'me@dev')
    ).resolves.toBeNull()
  })

  it('keeps the prompt open for a Pod client on a windowless host and takes its answer', async () => {
    const events: PodSshCredentialEvent[] = []
    const stop = podSshCredentialHub.subscribe((event) => events.push(event))
    try {
      const pending = requestCredential(() => null, 'target-1', 'passphrase', '~/.ssh/id_ed25519')
      const opened = events[0]
      expect(opened).toMatchObject({
        type: 'sshCredentialRequested',
        targetId: 'target-1',
        kind: 'passphrase',
        detail: '~/.ssh/id_ed25519',
        expiresAtMs: expect.any(Number)
      })
      const requestId = opened.requestId

      expect(podSshCredentialHub.submit(requestId, 'secret')).toBe(true)

      await expect(pending).resolves.toBe('secret')
      expect(events.at(-1)).toEqual({
        type: 'sshCredentialResolved',
        requestId,
        reason: 'submitted'
      })
      expect(podSshCredentialHub.submit(requestId, 'again')).toBe(false)
    } finally {
      stop()
    }
  })

  it("settles the Pod client's copy when the desktop's dialog answers first", async () => {
    const window = credentialWindow()
    const events: PodSshCredentialEvent[] = []
    const stop = podSshCredentialHub.subscribe((event) => events.push(event))
    const controller = new AbortController()
    try {
      const pending = requestCredential(
        () => window,
        'target-1',
        'password',
        'me@dev',
        undefined,
        controller.signal
      )
      const request = vi.mocked(window.webContents.send).mock.calls[0][1] as { requestId: string }
      expect(events).toEqual([expect.objectContaining({ requestId: request.requestId })])

      controller.abort()

      await expect(pending).resolves.toBeNull()
      expect(events.at(-1)).toEqual({
        type: 'sshCredentialResolved',
        requestId: request.requestId,
        reason: 'aborted'
      })
    } finally {
      stop()
    }
  })

  it('settles the Pod copy as timed out when nobody answers in time', async () => {
    vi.useFakeTimers()
    const events: PodSshCredentialEvent[] = []
    const stop = podSshCredentialHub.subscribe((event) => events.push(event))
    try {
      const pending = requestCredential(() => null, 'target-1', 'password', 'me@dev')
      const opened = events[0]
      expect(opened?.type === 'sshCredentialRequested' && opened.expiresAtMs).toBe(
        Date.now() + SSH_CREDENTIAL_TIMEOUT_MS
      )

      vi.advanceTimersByTime(SSH_CREDENTIAL_TIMEOUT_MS)

      await expect(pending).resolves.toBeNull()
      expect(events.at(-1)).toMatchObject({ type: 'sshCredentialResolved', reason: 'timeout' })
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('never logs or streams the answer itself', async () => {
    const secret = 'pod-secret-passphrase-7f3a'
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
    const events: PodSshCredentialEvent[] = []
    const stop = podSshCredentialHub.subscribe((event) => events.push(event))
    try {
      const pending = requestCredential(() => null, 'target-1', 'passphrase', '~/.ssh/id_ed25519')
      podSshCredentialHub.submit(events[0]?.requestId ?? '', secret)

      await expect(pending).resolves.toBe(secret)
      expect(JSON.stringify(events)).not.toContain(secret)
      for (const log of logs) {
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
      }
    } finally {
      stop()
      logs.forEach((log) => log.mockRestore())
    }
  })
})
