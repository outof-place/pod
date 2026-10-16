import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimHelperSupervisor, type SimHelperSupervisorOptions } from './sim-helper-supervisor'

const UDID = '8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0'

/** What child_process.spawn throws for a file the kernel will not execute. */
function enoexec(): Error {
  return Object.assign(new Error('spawn ENOEXEC'), {
    code: 'ENOEXEC',
    errno: -8,
    syscall: 'spawn /x/pod-sim',
    path: '/x/pod-sim'
  })
}

/** A child that started and then died, so the next launch comes from the restart timer. */
class DyingChild extends EventEmitter {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill(): boolean {
    this.emit('exit', null, 'SIGKILL')
    return true
  }
}

function supervisor(options: Partial<SimHelperSupervisorOptions>): SimHelperSupervisor {
  return new SimHelperSupervisor({
    platform: 'darwin',
    packaged: false,
    resolveBinary: () => '/x/pod-sim',
    log: () => {},
    ...options
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a spawn that throws never escapes the supervisor', () => {
  it('start() returns, and the helper is restarting with a typed spawnFailed', async () => {
    const helper = supervisor({
      spawn: () => {
        throw enoexec()
      },
      restartDelayMs: () => 60_000
    })
    expect(() => helper.start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(helper.state()).toMatchObject({
      state: 'restarting',
      failure: { kind: 'unavailable', reason: 'spawnFailed' }
    })
    const state = helper.state()
    expect(state.state === 'restarting' && state.failure.message).toContain('ENOEXEC')
    await helper.stop()
  })

  it('a call answers spawnFailed instead of rejecting', async () => {
    const helper = supervisor({
      spawn: () => {
        throw enoexec()
      },
      restartDelayMs: () => 60_000
    })
    const reply = helper.call('displayStats', { udid: UDID })
    await vi.advanceTimersByTimeAsync(0)
    await expect(reply).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'unavailable', reason: 'spawnFailed' }
    })
    await helper.stop()
  })

  it('a throw from the restart timer is caught and scheduled again', async () => {
    let spawns = 0
    const first = new DyingChild()
    const helper = supervisor({
      spawn: () => {
        spawns += 1
        if (spawns === 1) {
          return first
        }
        throw enoexec()
      },
      restartDelayMs: () => 100
    })
    helper.start()
    first.emit('exit', 70, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(helper.state()).toMatchObject({ state: 'restarting', failure: { reason: 'crashed' } })

    // The timer's launch is the one that throws; fake timers re-throw anything a timer threw.
    await vi.advanceTimersByTimeAsync(100)
    expect(spawns).toBe(2)
    expect(helper.state()).toMatchObject({
      state: 'restarting',
      failure: { reason: 'spawnFailed' }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(spawns).toBe(3)
    await helper.stop()
  })
})
