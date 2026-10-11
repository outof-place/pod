// A reattach whose snapshot was taken after the attach (the durable overlay drains output first):
// bytes the stream delivered in between are inside that snapshot's sequence and in main's count.
import { describe, expect, it, vi } from 'vitest'
import { createRuntime } from './orca-runtime-test-fixtures.spec'

const LINE = `${'x'.repeat(53)}\n`

describe('provider sequence sync across a reattach', () => {
  it('counts bytes that reached main after the attach once, so provider snapshots line up', async () => {
    const runtime = createRuntime()
    let daemonSequence = 1000
    const serializeProviderBuffer = vi.fn(async () => ({
      data: 'screen',
      cols: 80,
      rows: 24,
      seq: daemonSequence,
      source: 'headless' as const
    }))
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer
    })
    const atSpawnStart = runtime.getPtyOutputSequence('pty-1')
    // Attached at 1000; two lines stream to main while the overlay drains, the first of them
    // before its snapshot (1054).
    runtime.onPtyData('pty-1', LINE, 1)
    runtime.onPtyData('pty-1', LINE, 2)
    daemonSequence = 1108
    const boundary = runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 1054, generation: 'continued' },
      atSpawnStart,
      1000
    )
    expect(runtime.getPtyOutputSequence('pty-1')).toBe(1108)
    expect(boundary).toBe(1108)
    runtime.onPtyData('pty-1', LINE, 3)
    daemonSequence = 1162
    expect(runtime.getPtyOutputSequence('pty-1')).toBe(1162)
    const snapshot = await runtime.serializeAuthoritativeTerminalBuffer('pty-1')
    expect(snapshot?.seq).toBe(runtime.getPtyOutputSequence('pty-1'))
  })

  it("keeps the snapshot's boundary when nothing reached main before the sync", () => {
    const runtime = createRuntime()
    const boundary = runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 1054, generation: 'continued' },
      runtime.getPtyOutputSequence('pty-1'),
      1000
    )
    // The 54 bytes after the attach still arrive; they are in the snapshot, so they end at 1054.
    expect(runtime.getPtyOutputSequence('pty-1')).toBe(1000)
    expect(boundary).toBe(1054)
  })

  it('counts from the snapshot as before when the provider names no attach point', () => {
    const runtime = createRuntime()
    const atSpawnStart = runtime.getPtyOutputSequence('pty-1')
    runtime.onPtyData('pty-1', LINE, 1)
    const boundary = runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 1000, generation: 'continued' },
      atSpawnStart
    )
    expect(runtime.getPtyOutputSequence('pty-1')).toBe(1054)
    expect(boundary).toBe(1054)
  })
})
