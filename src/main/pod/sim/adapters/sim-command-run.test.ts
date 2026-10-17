import { describe, expect, it } from 'vitest'
import { simRunProcess } from './sim-command-run'

describe.skipIf(process.platform === 'win32')('running a tool for the pool', () => {
  it('answers a tool killed by a signal as a failed run, never as an exit code', async () => {
    const killed = await simRunProcess('/bin/sh', ['-c', 'kill -9 $$'], { timeoutMs: 10_000 })
    expect(killed).toMatchObject({ ok: false, reason: 'signal' })
    const exited = await simRunProcess('/bin/sh', ['-c', 'exit 3'], { timeoutMs: 10_000 })
    expect(exited).toMatchObject({ ok: true, code: 3 })
  })
})
