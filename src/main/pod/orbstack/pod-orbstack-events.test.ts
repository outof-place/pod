import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodOrbstackEvent } from '../../../shared/pod-orbstack-types'
import { createPodOrbstackEvents, type PodOrbstackRelayRowInput } from './pod-orbstack-events'

const row = (status: number): PodOrbstackRelayRowInput => ({
  machine: 'pod-x-sbx',
  route: 'hook',
  method: 'POST',
  path: '/hook/claude',
  status,
  bytesUp: 10,
  bytesDown: 5,
  ms: 1,
  refused: null
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('orbstack events', () => {
  it('sends changed and relay at most once per 250 ms per subscriber', () => {
    const events = createPodOrbstackEvents({ now: () => Date.now() })
    const seen: PodOrbstackEvent[] = []
    events.subscribe((event) => seen.push(event))

    events.changed()
    expect(seen).toEqual([{ type: 'changed' }])
    events.changed()
    events.relay(row(200))
    events.relay(row(403))
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(249)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(seen.slice(1)).toEqual([
      { type: 'changed' },
      {
        type: 'relay',
        rows: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })]
      }
    ])
  })

  it('sends progress at once and seeds new subscribers from the last 256 rows', () => {
    const events = createPodOrbstackEvents({ now: () => Date.now() })
    for (let index = 0; index < 300; index += 1) {
      events.relay(row(200))
    }
    const seen: PodOrbstackEvent[] = []
    const { seed, stop } = events.subscribe((event) => seen.push(event))
    expect(seed).toHaveLength(256)
    expect(seed[0]?.seq).toBe(45)
    expect(seed.at(-1)?.seq).toBe(300)
    events.progress('repo::/x', 'sandbox', 'Cloning the template')
    expect(seen).toEqual([
      { type: 'progress', worktreeId: 'repo::/x', kind: 'sandbox', step: 'Cloning the template' }
    ])
    stop()
    events.changed()
    vi.runAllTimers()
    expect(seen).toHaveLength(1)
    expect(events.subscriberCount()).toBe(0)
  })
})
