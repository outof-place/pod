// Triage repro for stablyai/orca#27169 (closed): the leading-edge flush doubles frames on small bursts.
// Asserts the pre-#27169 frame count, so it FAILS while the leading edge is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalOutputBatcher } from './terminal-output-batcher'

function countFramesFor100SixteenChunkBursts(): number {
  let frames = 0
  const batcher = createTerminalOutputBatcher(() => {
    frames += 1
  })
  try {
    let seq = 0
    for (let burst = 0; burst < 100; burst += 1) {
      for (let chunk = 0; chunk < 16; chunk += 1) {
        seq += 1
        batcher.push('x'.repeat(64), { seq, rawLength: 64 })
        vi.advanceTimersByTime(0.1)
      }
      // Quiet spell longer than the 5 ms coalescing window.
      vi.advanceTimersByTime(20)
    }
    batcher.flush()
  } finally {
    batcher.dispose()
  }
  return frames
}

describe('triage #27169: frames per small burst', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('kill switch off: one frame per burst (baseline)', () => {
    vi.stubEnv('ORCA_TERMINAL_OUTPUT_LEADING_EDGE', '0')
    expect(countFramesFor100SixteenChunkBursts()).toBe(100)
  })

  it('default (leading edge on) should not add frames to a sixteen-chunk burst', () => {
    vi.stubEnv('ORCA_TERMINAL_OUTPUT_LEADING_EDGE', '1')
    expect(countFramesFor100SixteenChunkBursts()).toBe(100)
  })
})
