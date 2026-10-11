// Fork-only (Pod): how a version 2 PodNative quits this runtime. The runtime answers at once and
// never waits on the user itself: either `needsConfirmation` (PodNative asks in its own window and
// sends quit again, confirmed) or `quitting`, then a heartbeat every second until exit, so
// PodNative kills only a runtime that stopped answering, never one waiting on a prompt.
// Electron-free: pod-ui-host.ts wires it to the app and the renderer.
import type { PodUiHostQuitBlockers } from '../../../shared/pod-ui-host-quit'
import type { PodUiHostQuitReason, PodUiHostServerMessage } from './pod-ui-host-protocol'

export const POD_UI_HOST_QUIT_HEARTBEAT_MS = 1_000

export type PodUiHostQuitDeps = {
  /** What a quit would lose; null when no renderer could answer (gone, hung or not loaded). */
  assess: () => Promise<PodUiHostQuitBlockers | null>
  runningAgents: () => number
  /** Quits for real: the renderer's own prompts stand down, then the app quits. */
  commit: (reason: PodUiHostQuitReason) => void
  send: (message: PodUiHostServerMessage) => boolean
  log: (message: string) => void
  heartbeatMs?: number
}

export class PodUiHostQuitFlow {
  private assessing = false
  private committed: PodUiHostQuitReason | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: PodUiHostQuitDeps) {}

  get isCommitted(): boolean {
    return this.committed !== null
  }

  async request(reason: PodUiHostQuitReason, confirmed: boolean): Promise<void> {
    if (this.committed) {
      // A repeated quit while going: say so again; the heartbeat runs already.
      this.deps.send({ type: 'quitting', reason: this.committed })
      return
    }
    if (this.assessing) {
      return
    }
    if (!confirmed) {
      this.assessing = true
      let blockers: PodUiHostQuitBlockers | null
      try {
        blockers = await this.deps.assess()
      } catch {
        // Why: an assessment must never trap the quit; nothing it could not read blocks it.
        blockers = null
      } finally {
        this.assessing = false
      }
      if (this.committed) {
        return
      }
      const unsavedFiles = blockers?.unsavedFiles ?? 0
      const remoteWork = blockers?.remoteWork ?? 'none'
      if (unsavedFiles > 0 || remoteWork !== 'none') {
        this.deps.log(
          `ui-host: quit needs confirmation (${unsavedFiles} unsaved, remote ${remoteWork})`
        )
        this.deps.send({
          type: 'needsConfirmation',
          reason: unsavedFiles > 0 ? 'unsavedChanges' : 'remoteWork',
          unsavedFiles,
          remoteWork: remoteWork === 'none' ? null : remoteWork,
          runningAgents: this.deps.runningAgents()
        })
        return
      }
    }
    this.committed = reason
    this.deps.send({ type: 'quitting', reason })
    this.heartbeat = setInterval(
      () => this.deps.send({ type: 'quitHeartbeat' }),
      this.deps.heartbeatMs ?? POD_UI_HOST_QUIT_HEARTBEAT_MS
    )
    this.heartbeat.unref?.()
    this.deps.commit(reason)
  }

  /** The committed quit was vetoed (the renderer kept the window): this runtime stays. */
  aborted(reason: string): void {
    if (!this.committed) {
      return
    }
    this.committed = null
    this.stopHeartbeat()
    this.deps.log(`ui-host: quit aborted (${reason})`)
    this.deps.send({ type: 'quitAborted', reason })
  }

  dispose(): void {
    this.stopHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }
}
