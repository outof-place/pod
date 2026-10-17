import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { PowerMonitor } from 'electron'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SimPowerEvents } from './sim-clock'
import type { SimRun } from './sim-command-run'
import { createSimLiveness } from './sim-liveness'
import { simPodHome } from './sim-pod-home'
import { createSimProcessFacts, type SimProcessFacts } from './sim-process-facts'
import { createSimRealPorts, simRuntimeOf } from './sim-pool-real-ports'

function timers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
}

const NEVER_WRITTEN = '/private/tmp/pod-sim-ports-never-written'

function options(run: SimRun, power: EventEmitter | null = null) {
  return {
    home: simPodHome({ POD_SIM_HOME: NEVER_WRITTEN }),
    leaseDirectory: `${NEVER_WRITTEN}/leases`,
    claudeAcc: { binary: null, stateFile: '/nonexistent', configFile: '/nonexistent' },
    self: { pid: process.pid, startedAt: 1, profile: 'test' },
    waiters: { notify: () => undefined },
    power,
    panes: null,
    run
  }
}

/** A process table that knows only this process, started `startedAt`. */
function startsAt(startedAt: number): SimProcessFacts {
  return {
    startOf: async (pid) => (pid === process.pid ? { found: true, startedAt } : { found: false }),
    table: async () => []
  }
}

describe('the pool’s real ports', () => {
  it('start no timer and no process until the coordinator calls them, and let go on dispose', async () => {
    const spawned: string[] = []
    const run: SimRun = async (program) => {
      spawned.push(program)
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    const power = new EventEmitter()
    const before = timers()
    const made = createSimRealPorts({ ...options(run, power), platform: 'darwin' })
    if (!made.ok) {
      throw new Error(made.message)
    }
    const { ports } = made
    ports.clock.now()
    await new Promise((resolve) => setImmediate(resolve))
    expect(timers()).toBe(before)
    expect(spawned).toEqual([])
    expect(power.listenerCount('suspend') + power.listenerCount('resume')).toBe(2)
    ports.dispose()
    expect(power.listenerCount('suspend') + power.listenerCount('resume')).toBe(0)
    expect(existsSync(NEVER_WRITTEN)).toBe(false)
  })

  it('are not made off macOS', () => {
    const run: SimRun = async () => ({ ok: true, code: 0, stdout: '', stderr: '' })
    expect(createSimRealPorts({ ...options(run), platform: 'linux' })).toMatchObject({
      ok: false,
      reason: 'notMacOS'
    })
  })

  it('takes Electron’s own powerMonitor as the sleep signal', () => {
    expectTypeOf<PowerMonitor>().toExtend<SimPowerEvents>()
  })

  it('names a runtime by a profile id that survives its restart and differs per profile', async () => {
    const facts = startsAt(1_760_000_000)
    const pod = await simRuntimeOf('/Users/f/Library/Application Support/Pod', facts)
    expect(pod?.pid).toBe(process.pid)
    const again = await simRuntimeOf('/Users/f/Library/Application Support/Pod', facts)
    expect(pod?.profile).toBe(again?.profile)
    const probe = await simRuntimeOf('/Users/f/Library/Application Support/pn-x', facts)
    expect(pod?.profile).not.toBe(probe?.profile)
    expect(pod?.profile.length).toBeLessThanOrEqual(128)
  })

  it('names a runtime by the start its peers read, so a slow start never reads as exited', async () => {
    // The kernel's start three seconds before Node's own time origin (a cold Electron start).
    const facts = startsAt(Math.floor(performance.timeOrigin / 1000) - 3)
    const self = await simRuntimeOf('/Users/f/Library/Application Support/Pod', facts)
    if (!self) {
      throw new Error('no start')
    }
    const peer = createSimLiveness({
      deviceSet: '/x',
      processes: facts,
      panes: null,
      podDevices: async () => new Set()
    })
    expect(await peer.runtime(self)).toBe('live')
  })

  it.skipIf(process.platform === 'win32')(
    'reads its own start from the process table, as a peer reads it',
    async () => {
      const facts = createSimProcessFacts()
      const self = await simRuntimeOf('/Users/f/Library/Application Support/Pod', facts)
      if (!self) {
        throw new Error('no start')
      }
      expect(await facts.startOf(process.pid)).toEqual({ found: true, startedAt: self.startedAt })
      const peer = createSimLiveness({
        deviceSet: '/x',
        processes: createSimProcessFacts({ env: { ...process.env, TZ: 'Asia/Tokyo' } }),
        panes: null,
        podDevices: async () => new Set()
      })
      expect(await peer.runtime(self)).toBe('live')
    }
  )
})
