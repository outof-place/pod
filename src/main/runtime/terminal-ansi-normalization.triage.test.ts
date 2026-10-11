// Triage repro for stablyai/orca#27170 (closed, superseded by #27344): retained CSI params scanned twice.
// The first case is #27344's own regression test; it FAILS on Pod's #27170 copy.
import { describe, expect, it, vi } from 'vitest'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import { splitRetainedTerminalTailSegments } from './terminal-tail-line-controls'

describe('triage #27170', () => {
  it('scans retained CSI parameters once while normalizing (#27344 test)', () => {
    const input = `\x1b[${'1;'.repeat(2048)}A`
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    let normalized: ReturnType<typeof normalizeTerminalChunk>
    let inspections: number
    try {
      normalized = normalizeTerminalChunk(input)
      inspections = charCodeAt.mock.calls.length
    } finally {
      charCodeAt.mockRestore()
    }
    expect(normalized).toEqual({ text: input, pendingAnsi: '' })
    expect(inspections).toBeLessThanOrEqual(input.length + 8)
  })

  it('splits dense blank lines without one indexOf call per newline per pass', () => {
    const input = '\n'.repeat(4096)
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    let calls: number
    try {
      splitRetainedTerminalTailSegments(input)
      calls = indexOf.mock.calls.length
    } finally {
      indexOf.mockRestore()
    }
    // Base walked code units once per pass; Pod's copy pays a native call per newline per pass.
    expect(calls).toBeLessThan(input.length)
  })
})
