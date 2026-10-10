// Fork-only (Pod): what `orbstack.subscribe` streams. The relay log lives only in this ring, in
// memory; `changed` and `relay` reach each subscriber at most once per 250 ms.
import type {
  PodOrbstackEvent,
  PodOrbstackMachineKind,
  PodOrbstackRelayRow
} from '../../../shared/pod-orbstack-types'

const RING_ROWS = 256
const COALESCE_MS = 250

export type PodOrbstackRelayRowInput = Omit<PodOrbstackRelayRow, 'seq' | 'at'>

type Subscriber = {
  emit: (event: PodOrbstackEvent) => void
  lastAt: number
  changed: boolean
  rows: PodOrbstackRelayRow[]
  timer: ReturnType<typeof setTimeout> | null
}

export function createPodOrbstackEvents(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now
  const ring: PodOrbstackRelayRow[] = []
  const subscribers = new Set<Subscriber>()
  let seq = 0

  const flush = (subscriber: Subscriber): void => {
    subscriber.timer = null
    subscriber.lastAt = now()
    if (subscriber.changed) {
      subscriber.changed = false
      subscriber.emit({ type: 'changed' })
    }
    if (subscriber.rows.length > 0) {
      subscriber.emit({ type: 'relay', rows: subscriber.rows.splice(0) })
    }
  }

  // Leading edge when the subscriber was quiet, else one trailing flush per window.
  const schedule = (subscriber: Subscriber): void => {
    if (subscriber.timer) {
      return
    }
    const wait = subscriber.lastAt + COALESCE_MS - now()
    if (wait <= 0) {
      flush(subscriber)
      return
    }
    subscriber.timer = setTimeout(() => flush(subscriber), wait)
    subscriber.timer.unref?.()
  }

  return {
    /** Registry, template or machine state moved: subscribers re-read the status. */
    changed(): void {
      for (const subscriber of subscribers) {
        subscriber.changed = true
        schedule(subscriber)
      }
    },
    progress(worktreeId: string, kind: PodOrbstackMachineKind, step: string): void {
      for (const subscriber of subscribers) {
        subscriber.emit({ type: 'progress', worktreeId, kind, step })
      }
    },
    relay(input: PodOrbstackRelayRowInput): void {
      seq += 1
      const row: PodOrbstackRelayRow = { seq, at: now(), ...input }
      ring.push(row)
      if (ring.length > RING_ROWS) {
        ring.shift()
      }
      for (const subscriber of subscribers) {
        subscriber.rows.push(row)
        if (subscriber.rows.length > RING_ROWS) {
          subscriber.rows.shift()
        }
        schedule(subscriber)
      }
    },
    /** Starts a stream: the caller gets the ring as its seed and every event after it. */
    subscribe(emit: (event: PodOrbstackEvent) => void): {
      seed: PodOrbstackRelayRow[]
      stop: () => void
    } {
      const subscriber: Subscriber = { emit, lastAt: 0, changed: false, rows: [], timer: null }
      subscribers.add(subscriber)
      return {
        seed: [...ring],
        stop: () => {
          subscribers.delete(subscriber)
          if (subscriber.timer) {
            clearTimeout(subscriber.timer)
          }
        }
      }
    },
    subscriberCount: (): number => subscribers.size
  }
}

export type PodOrbstackEvents = ReturnType<typeof createPodOrbstackEvents>
