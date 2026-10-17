// Fork-only (Pod): the live views (startStream) a helper replacement must not lose. Each viewer's
// rendezvous name stays checked in while the helper restarts, so the new helper streams to it again
// under the same token and nonce; frame numbers start over at 1 behind a fresh surface message
// (pod_sim_frame.h).
import type { SimHelperConnection } from './sim-helper-connection'
import type { SimHelperStreamEnded } from './sim-helper-events'
import {
  SIM_HELPER_METHODS,
  type SimHelperMethod,
  type SimHelperParams
} from './sim-helper-protocol'

type StreamParams = SimHelperParams<'startStream'>
// Each startStream the helper accepted is a generation of its view: a view started again under the
// same token is a newer one, even with the same params.
type View = { params: StreamParams; generation: number }
// Ends that came before their start's reply was handled (both lines in one read), kept briefly.
const MAX_EARLY_ENDS = 64

export class SimHelperLiveViews {
  // Started and not stopped, by udid and token.
  private readonly views = new Map<string, View>()
  private readonly earlyEnds = new Set<string>()
  private generations = 0

  get size(): number {
    return this.views.size
  }

  /** Before any call goes out: a stopStream forgets its view first, so a racing replay leaves it be. */
  calling(method: SimHelperMethod, params: unknown): void {
    if (method !== 'stopStream') {
      return
    }
    const parsed = SIM_HELPER_METHODS.stopStream.params.safeParse(params)
    const view = parsed.success ? this.views.get(key(parsed.data)) : undefined
    // A stop naming another generation's nonce leaves this one.
    if (parsed.success && view && (parsed.data.nonce ?? view.params.nonce) === view.params.nonce) {
      this.views.delete(key(parsed.data))
    }
  }

  /** After the helper accepted any call: a startStream is a new generation of its view. */
  accepted(method: SimHelperMethod, params: unknown): void {
    if (method !== 'startStream') {
      return
    }
    const parsed = SIM_HELPER_METHODS.startStream.params.safeParse(params)
    if (parsed.success && !this.earlyEnds.delete(stream(parsed.data))) {
      this.generations += 1
      this.views.set(key(parsed.data), { params: parsed.data, generation: this.generations })
    }
  }

  /** The helper ended a view on its own (streamEnded): forgotten unless a newer one took its token. */
  ended(event: SimHelperStreamEnded): void {
    if (this.views.get(key(event))?.params.nonce === event.nonce) {
      this.views.delete(key(event))
      return
    }
    this.earlyEnds.add(stream(event))
    if (this.earlyEnds.size > MAX_EARLY_ENDS) {
      this.earlyEnds.delete(this.earlyEnds.values().next().value ?? '')
    }
  }

  /**
   * On a replacement helper: each view again, while `connection` is still the current one. A view
   * the helper refuses (its viewer is gone, the device shut down) is forgotten and reported to
   * `refused` as ended by the restart. When the caller stopped or restarted a view while its replay was under way, the
   * replay stops only its own stream (by nonce), and starts the caller's again when its own had
   * replaced it in the helper.
   */
  async replay(
    connection: SimHelperConnection,
    budgetMs: number,
    isCurrent: () => boolean,
    log: (message: string) => void,
    refused: (ended: SimHelperStreamEnded) => void
  ): Promise<void> {
    // Views started from here on reach the new helper by themselves.
    const before = this.generations
    for (const name of Array.from(this.views.keys())) {
      let view = this.views.get(name)
      if (!view || view.generation > before) {
        continue
      }
      while (view && isCurrent()) {
        const reply = await connection.call('startStream', view.params, budgetMs)
        const now = this.views.get(name)
        if (!reply.ok) {
          if (reply.failure.kind === 'error' && now === view) {
            this.views.delete(name)
            log(`live view ${name} not restarted: ${reply.failure.message}`)
            const { udid, token, nonce } = view.params
            refused({ udid, token, nonce, reason: 'helperRestart' })
          }
          break
        }
        if (now && sameStream(now.params, view.params)) {
          break
        }
        // Stopped or started again meanwhile: stop only this replay's own stream.
        const { udid, token, nonce } = view.params
        const stop = await connection.call('stopStream', { udid, token, nonce }, budgetMs)
        // It was still the helper's, so it had replaced a newer start: that one goes again.
        view = stop.ok ? this.views.get(name) : undefined
      }
    }
  }
}

function key(params: { udid: string; token: number }): string {
  return `${params.udid.toUpperCase()} ${params.token}`
}

function stream(params: { udid: string; token: number; nonce: string }): string {
  return `${key(params)} ${params.nonce}`
}

function sameStream(a: StreamParams, b: StreamParams): boolean {
  return (
    a.udid.toUpperCase() === b.udid.toUpperCase() &&
    a.service === b.service &&
    a.token === b.token &&
    a.nonce === b.nonce
  )
}
