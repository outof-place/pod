// Fork-only (Pod): SSH credential prompts for runtime RPC clients beside the desktop's dialog
// (ssh-passphrase.ts), so a windowless one-app host can still ask PodNative. Electron-free.
import type {
  PodSshCredentialEvent,
  PodSshCredentialRequest,
  PodSshCredentialSettleReason
} from '../../../shared/pod-ssh-credential-event'

type OpenPrompt = { request: PodSshCredentialRequest; answer: (value: string | null) => void }

export class PodSshCredentialHub {
  private readonly open = new Map<string, OpenPrompt>()
  private readonly listeners = new Set<(event: PodSshCredentialEvent) => void>()

  /** Returns whether a client listens, so a host without a window knows someone may answer. */
  ask(request: PodSshCredentialRequest, answer: (value: string | null) => void): boolean {
    this.open.set(request.requestId, { request, answer })
    this.emit({ type: 'sshCredentialRequested', ...request })
    return this.listeners.size > 0
  }

  /** The prompt settled, whoever answered it. */
  settle(requestId: string, reason: PodSshCredentialSettleReason): void {
    if (this.open.delete(requestId)) {
      this.emit({ type: 'sshCredentialResolved', requestId, reason })
    }
  }

  /** False when no prompt has this id (already answered, timed out or never opened). */
  submit(requestId: string, value: string | null): boolean {
    const prompt = this.open.get(requestId)
    if (!prompt) {
      return false
    }
    prompt.answer(value)
    return true
  }

  /** `listener` first gets the prompts already open, oldest first. */
  subscribe(listener: (event: PodSshCredentialEvent) => void): () => void {
    this.listeners.add(listener)
    for (const { request } of this.open.values()) {
      listener({ type: 'sshCredentialRequested', ...request })
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: PodSshCredentialEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[ssh] a credential prompt listener failed', error)
      }
    }
  }
}

export const podSshCredentialHub = new PodSshCredentialHub()
