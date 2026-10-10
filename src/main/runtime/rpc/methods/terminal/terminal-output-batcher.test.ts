import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalOutputSourceRange } from '../../../../../shared/terminal-output-source-range'
import {
  TERMINAL_OUTPUT_LEADING_EDGE_MAX_BYTES,
  createTerminalOutputBatcher
} from './terminal-output-batcher'

function range(start: number): TerminalOutputSourceRange {
  return {
    id: 'pty',
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: 1,
    ptyIncarnation: 'incarnation',
    deliveryToken: 'delivery',
    spanId: `span-${start}`,
    sourceStartSu: start,
    sourceEndSu: start + 1,
    displayStart: start,
    displayEnd: start + 1,
    splittable: true,
    transform: { transformed: false, rawLengthSu: 1, scalarSafe: true }
  }
}

it('keeps delivered ranges frozen and isolated from reentrant flushes and disposal', () => {
  const firstRange = range(0)
  const secondRange = range(1)
  const sourceRanges = [firstRange]
  const delivered: (readonly TerminalOutputSourceRange[])[] = []
  const batcher = createTerminalOutputBatcher((_data, meta) => {
    delivered.push(meta!.sourceRanges!)
    if (delivered.length === 1) {
      batcher.push('b', { sourceRanges: [secondRange] })
      batcher.flush()
    }
  })
  try {
    batcher.push('a', { sourceRanges })
    batcher.flush()
    sourceRanges.push(secondRange)
    batcher.dispose()
    expect(delivered).toEqual([[firstRange], [secondRange]])
    expect(delivered[0]).not.toBe(delivered[1])
    expect(delivered.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(sourceRanges)).toBe(false)
  } finally {
    batcher.dispose()
  }
})

describe('leading-edge flush', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  function collect() {
    const delivered: { data: string; seq?: number }[] = []
    const batcher = createTerminalOutputBatcher((data, meta) => {
      delivered.push({ data, ...(typeof meta?.seq === 'number' ? { seq: meta.seq } : {}) })
    })
    return { batcher, delivered }
  }

  it('sends a small chunk at once after a quiet spell and batches what follows', () => {
    const { batcher, delivered } = collect()
    batcher.push('k', { seq: 1, rawLength: 1 })
    expect(delivered).toEqual([{ data: 'k', seq: 1 }])

    vi.advanceTimersByTime(1)
    batcher.push('a', { seq: 2, rawLength: 1 })
    batcher.push('b', { seq: 3, rawLength: 1 })
    expect(delivered).toHaveLength(1)
    vi.advanceTimersByTime(5)
    expect(delivered).toEqual([
      { data: 'k', seq: 1 },
      { data: 'ab', seq: 3 }
    ])
    batcher.dispose()
  })

  it('counts quiet time from the last enqueue, not the last flush', () => {
    const { batcher, delivered } = collect()
    batcher.push('1')
    vi.advanceTimersByTime(4)
    // 4 ms after the last enqueue: part of the same burst.
    batcher.push('2')
    expect(delivered.map((entry) => entry.data)).toEqual(['1'])
    vi.advanceTimersByTime(5)
    expect(delivered.map((entry) => entry.data)).toEqual(['1', '2'])
    vi.advanceTimersByTime(1)
    // 1 ms after that flush but 6 ms after the last enqueue: quiet again.
    batcher.push('3')
    batcher.push('4')
    expect(delivered.map((entry) => entry.data)).toEqual(['1', '2', '3'])
    vi.advanceTimersByTime(5)
    expect(delivered.map((entry) => entry.data)).toEqual(['1', '2', '3', '4'])
    batcher.dispose()
  })

  it('keeps batching chunks larger than the leading-edge limit', () => {
    const { batcher, delivered } = collect()
    batcher.push('x'.repeat(TERMINAL_OUTPUT_LEADING_EDGE_MAX_BYTES + 1))
    expect(delivered).toHaveLength(0)
    vi.advanceTimersByTime(5)
    expect(delivered).toHaveLength(1)
    batcher.dispose()
  })

  it('restores timer-only batching with the kill switch', () => {
    vi.stubEnv('ORCA_TERMINAL_OUTPUT_LEADING_EDGE', '0')
    const { batcher, delivered } = collect()
    batcher.push('k')
    expect(delivered).toHaveLength(0)
    vi.advanceTimersByTime(5)
    expect(delivered.map((entry) => entry.data)).toEqual(['k'])
    batcher.dispose()
  })
})
