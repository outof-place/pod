import { describe, expect, it } from 'vitest'
import type { SimRun, SimRunResult } from './sim-command-run'
import { createSimProcessFacts, simBootedOutsidePod } from './sim-process-facts'

const POD = '0A0A0A0A-0000-4000-8000-00000000000A'
const OTHER = 'D714382D-D685-4FBE-AB4D-9B369EF9F348'

function psReplying(reply: SimRunResult) {
  const calls: string[][] = []
  const run: SimRun = async (program, args, options) => {
    calls.push([program, ...args, `LC_ALL=${options.env?.LC_ALL}`, `TZ=${options.env?.TZ}`])
    return reply
  }
  return { facts: createSimProcessFacts({ run }), calls }
}

describe('process facts from ps', () => {
  it('reads a pid’s start as a time-zone-free epoch: ps in UTC and English, read as UTC', async () => {
    const { facts, calls } = psReplying({
      ok: true,
      code: 0,
      stdout: 'Ss   Sat Oct 17 03:32:53 2026\n',
      stderr: ''
    })
    expect(await facts.startOf(22623)).toEqual({
      found: true,
      startedAt: Date.UTC(2026, 9, 17, 3, 32, 53) / 1000
    })
    expect(calls[0]).toEqual([
      '/bin/ps',
      '-o',
      'stat=,lstart=',
      '-p',
      '22623',
      'LC_ALL=en_US.UTF-8',
      'TZ=UTC0'
    ])
  })

  it('reads gone only from a zombie or ps’s quiet exit 1; any other failure is unknown', async () => {
    const zombie = psReplying({
      ok: true,
      code: 0,
      stdout: 'Z    Sat Oct 17 03:32:53 2026',
      stderr: ''
    })
    expect(await zombie.facts.startOf(1)).toEqual({ found: false })
    const none = psReplying({ ok: true, code: 1, stdout: '', stderr: '' })
    expect(await none.facts.startOf(1)).toEqual({ found: false })
    const unknown: SimRunResult[] = [
      { ok: false, reason: 'timeout', message: 'ps ran past 3000 ms' },
      // Killed under memory pressure (the brake), or out of processes.
      { ok: false, reason: 'signal', message: '/bin/ps was killed by SIGKILL' },
      { ok: true, code: 1, stdout: '', stderr: 'ps: fork: Resource temporarily unavailable' },
      { ok: true, code: 2, stdout: '', stderr: '' },
      { ok: true, code: 0, stdout: 'Ss   gibberish', stderr: '' }
    ]
    for (const reply of unknown) {
      expect(await psReplying(reply).facts.startOf(1), JSON.stringify(reply)).toBe('unknown')
    }
  })

  it.skipIf(process.platform === 'win32')(
    'reads the same start for a process whatever time zone the runtime runs in',
    async () => {
      const starts = await Promise.all(
        ['America/Los_Angeles', 'Asia/Tokyo', 'UTC'].map((TZ) =>
          createSimProcessFacts({ env: { ...process.env, TZ } }).startOf(process.pid)
        )
      )
      expect(starts[0]).toMatchObject({ found: true })
      expect(starts[1]).toEqual(starts[0])
      expect(starts[2]).toEqual(starts[0])
      const started = starts[0] !== 'unknown' && starts[0].found ? starts[0].startedAt : 0
      // performance.timeOrigin is this process's own idea of its start: close, not the same.
      expect(Math.abs(started - performance.timeOrigin / 1000)).toBeLessThan(120)
    }
  )

  it('reads the process table and counts simulators booted outside Pod’s set', async () => {
    const { facts } = psReplying({
      ok: true,
      code: 0,
      stdout: [
        '    1     0 /sbin/launchd',
        `  500     1 launchd_sim /Users/f/.pod/sim/CoreSimulator/Devices/${POD}/data/var/run/launchd_bootstrap.plist`,
        `  600     1 launchd_sim /Users/f/Library/Developer/CoreSimulator/Devices/${OTHER}/data/var/run/launchd_bootstrap.plist`,
        `  601   600 /Users/f/Library/Developer/CoreSimulator/Devices/${OTHER}/data/App`
      ].join('\n'),
      stderr: ''
    })
    expect(await facts.table()).toHaveLength(4)
    expect(await simBootedOutsidePod(facts, new Set([POD]))).toBe(1)
    const unreadable = psReplying({ ok: true, code: 1, stdout: '', stderr: 'ps: error' })
    expect(await simBootedOutsidePod(unreadable.facts, new Set([POD]))).toBe('unknown')
  })
})
