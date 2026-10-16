import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SimHelperSupervisor,
  simHelperRestartDelayMs,
  type SimHelperState,
  type SimHelperSupervisorOptions
} from './sim-helper-supervisor'

// A real child process speaking protocol v1 (see its header for the modes).
const FAKE = join(__dirname, '__fixtures__', 'fake-pod-sim.mjs')
const UDID = '8B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0'
const OTHER_UDID = '01C2D240-07BE-4772-AB65-D00D78C451A0'
const running: { supervisor: SimHelperSupervisor; dir: string }[] = []

type FakeConfig = {
  mode: string
  liveOnSpawns?: number[]
  liveMs?: number
  screenshotDelayMs?: number
  hidTimeoutMs?: number
  hidLog?: boolean
  hidDelayFirstMs?: number
}

function harness(config: string | FakeConfig, options: Partial<SimHelperSupervisorOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pod-sim-fake-'))
  writeFileSync(
    join(dir, 'fake.json'),
    JSON.stringify(typeof config === 'string' ? { mode: config } : config)
  )
  const binary = join(dir, 'pod-sim')
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(FAKE).href)})\n`
  )
  chmodSync(binary, 0o755)
  const states: SimHelperState[] = []
  const supervisor = new SimHelperSupervisor({
    platform: 'darwin',
    packaged: false,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
    resolveBinary: () => binary,
    restartDelayMs: () => 20,
    log: () => {},
    onState: (state) => states.push(state),
    ...options
  })
  running.push({ supervisor, dir })
  const spawns = (): { pid: number; token: string }[] => {
    try {
      return readFileSync(join(dir, 'spawns'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [pid, token = ''] = line.split(' ')
          return { pid: Number(pid), token }
        })
    } catch {
      return []
    }
  }
  const envOf = (spawn: number): Record<string, string> =>
    JSON.parse(readFileSync(join(dir, `env-${spawn}.json`), 'utf8'))
  return { supervisor, states, spawns, envOf, binary, dir }
}

// Generous: each fake spawn is a Node start, slow on a loaded machine.
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('condition not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  for (const { supervisor, dir } of running.splice(0)) {
    await supervisor.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('pod-sim helper supervisor', () => {
  it('spawns the helper, proves this spawn token and serves calls', async () => {
    const { supervisor, spawns } = harness('ok')
    const hello = await supervisor.hello()
    expect(hello.ok && hello.value.capabilities.display.status).toBe('ok')
    expect(hello.ok && hello.value.table.entry).toBe('Xcode 27.0 (27A266a)')
    const state = supervisor.state()
    expect(state.state === 'ready' && state.pid).toBe(spawns()[0]?.pid)

    const shot = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/pod-sim-shot.png' })
    expect(shot).toMatchObject({
      ok: true,
      value: { source: 'surface', path: '/tmp/pod-sim-shot.png' }
    })
  })

  it('a helper that refuses the token is unavailable with the reason, and calls answer instead of throwing', async () => {
    const { supervisor } = harness('wrongToken', { restartDelayMs: () => 60_000 })
    const hello = await supervisor.hello()
    expect(hello).toMatchObject({
      ok: false,
      failure: { kind: 'unavailable', reason: 'tokenMismatch' }
    })
    expect(!hello.ok && hello.failure.message).toMatch(/^helper unavailable: tokenMismatch/)
    const shot = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/x.png' })
    expect(shot).toMatchObject({ ok: false, failure: { reason: 'tokenMismatch' } })
  })

  it('a crash fails the call in flight as crashed, and a new helper serves the next call', async () => {
    const { supervisor, states, spawns } = harness('crashOnce')
    const first = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/a.png' })
    expect(first).toMatchObject({ ok: false, failure: { kind: 'unavailable', reason: 'crashed' } })
    expect(!first.ok && first.failure.message).toContain('exited with code 70')

    const second = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/b.png' })
    expect(second.ok).toBe(true)
    expect(spawns()).toHaveLength(2)
    const order = states.map((state) => state.state)
    expect(order.indexOf('restarting')).toBeGreaterThan(order.indexOf('ready'))
    expect(order.lastIndexOf('ready')).toBeGreaterThan(order.indexOf('restarting'))
  })

  it('replies that come back out of order reach the call that sent them', async () => {
    const { supervisor } = harness('reverse')
    expect((await supervisor.hello()).ok).toBe(true)
    const [first, second] = await Promise.all([
      supervisor.call('screenshot', { udid: UDID, path: '/tmp/first.png' }),
      supervisor.call('screenshot', { udid: UDID, path: '/tmp/second.png' })
    ])
    expect(first).toMatchObject({ ok: true, value: { path: '/tmp/first.png' } })
    expect(second).toMatchObject({ ok: true, value: { path: '/tmp/second.png' } })
  })

  it('a helper that answers its own timeout stays up and serves the next call', async () => {
    const { supervisor, spawns } = harness('helperTimeout')
    const shot = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/c.png' })
    expect(shot).toMatchObject({ ok: false, failure: { kind: 'error', code: 'timeout' } })
    expect((await supervisor.call('displayStats', { udid: UDID })).ok).toBe(true)
    expect(spawns()).toHaveLength(1)
    expect(supervisor.state()).toMatchObject({ state: 'ready', pid: spawns()[0]?.pid })
  })

  it('serves hid and ax as typed calls', async () => {
    const { supervisor } = harness('ok')
    const tap = await supervisor.call('hid', { udid: UDID, action: { kind: 'tap', x: 201, y: 82 } })
    expect(tap).toMatchObject({ ok: true, value: { udid: UDID, kind: 'tap' } })
    const ax = await supervisor.call('ax', { udid: UDID, filter: 'more' })
    expect(ax.ok && ax.value.nodes.map((node) => node.centre)).toContainEqual({ x: 349, y: 817 })
  })

  it('pipelined touch calls reach the helper in the order they were made, before it is ready and after', async () => {
    const { supervisor, dir } = harness({ mode: 'ok', hidLog: true, hidDelayFirstMs: 200 })
    const stream = (from: number) =>
      (['down', 'move', 'move', 'up'] as const).map((phase, offset) =>
        supervisor.call('hid', {
          udid: UDID,
          action: { kind: 'touch', phase, points: [{ x: from + offset, y: 20 }] }
        })
      )
    // Made while the helper starts: they wait for hello, then go out without waiting for answers.
    const starting = await Promise.all(stream(10))
    const ready = await Promise.all(stream(20))
    expect([...starting, ...ready].every((result) => result.ok)).toBe(true)
    expect(readFileSync(join(dir, 'hid.log'), 'utf8').trim().split('\n')).toEqual([
      'touch down 10',
      'touch move 11',
      'touch move 12',
      'touch up 13',
      'touch down 20',
      'touch move 21',
      'touch move 22',
      'touch up 23'
    ])
  })

  it('a hung hid on one device does not hold back a screenshot of another, and ends at the helper timeout without a restart', async () => {
    const { supervisor, spawns } = harness({ mode: 'hidHang', hidTimeoutMs: 1500 })
    expect((await supervisor.hello()).ok).toBe(true)
    let hidDone = false
    const hid = supervisor
      .call('hid', { udid: UDID, action: { kind: 'tap', x: 10, y: 10 } })
      .finally(() => {
        hidDone = true
      })
    const shot = await supervisor.call('screenshot', { udid: OTHER_UDID, path: '/tmp/other.png' })
    expect(shot).toMatchObject({ ok: true, value: { path: '/tmp/other.png' } })
    expect(hidDone).toBe(false)
    expect(await hid).toMatchObject({ ok: false, failure: { kind: 'error', code: 'timeout' } })
    expect(spawns()).toHaveLength(1)
    expect(supervisor.state()).toMatchObject({ state: 'ready', pid: spawns()[0]?.pid })
  })

  it('a helper that misses its own deadline plus the margin is recycled, reason timeout', async () => {
    const { supervisor, states, spawns } = harness('hang', { callBudgetMs: () => 300 })
    const shot = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/c.png' })
    expect(shot).toMatchObject({ ok: false, failure: { kind: 'unavailable', reason: 'timeout' } })
    await until(() => spawns().length === 2 && supervisor.state().state === 'ready')
    expect(states.find((state) => state.state === 'restarting')).toMatchObject({
      failure: { reason: 'timeout' }
    })
    expect((await supervisor.call('displayStats', { udid: UDID })).ok).toBe(true)
  })

  it('a call that waited through a restart still gets its whole in-flight budget', async () => {
    const { supervisor } = harness(
      { mode: 'crashOnce', screenshotDelayMs: 400 },
      { restartDelayMs: () => 700, callBudgetMs: () => 600 }
    )
    const first = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/a.png' })
    expect(first).toMatchObject({ ok: false, failure: { reason: 'crashed' } })
    // Waits 700 ms for the restart, longer than the budget, then 400 ms in flight, within it.
    const second = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/b.png' })
    expect(second).toMatchObject({ ok: true, value: { path: '/tmp/b.png' } })
  })

  it('an unknown build is unsupported per capability: display refuses, screenshots fall back to simctl', async () => {
    const { supervisor } = harness('unknownBuild')
    const hello = await supervisor.hello()
    expect(hello.ok && hello.value.table.known).toBe(false)
    expect(hello.ok && hello.value.capabilities.display).toMatchObject({
      status: 'unsupported',
      reason: 'CoreSimulator 1200.1 with SimulatorKit 1050.3 is not in the version table'
    })
    const attach = await supervisor.call('attachDisplay', { udid: UDID })
    expect(attach).toMatchObject({ ok: false, failure: { kind: 'error', code: 'unsupported' } })
    const shot = await supervisor.call('screenshot', { udid: UDID, path: '/tmp/d.png' })
    expect(shot).toMatchObject({ ok: true, value: { source: 'simctl' } })
  })

  it('without a binary it is unavailable (notFound) and picks one up on a later call', async () => {
    let binary: string | null = null
    const { supervisor, spawns, binary: fake } = harness('ok', { resolveBinary: () => binary })
    const missing = await supervisor.hello()
    expect(missing).toMatchObject({ ok: false, failure: { reason: 'notFound' } })
    expect(spawns()).toHaveLength(0)
    binary = fake
    expect((await supervisor.hello()).ok).toBe(true)
  })

  it('off macOS nothing is spawned', async () => {
    const { supervisor, spawns } = harness('ok', { platform: 'linux' })
    expect(await supervisor.hello()).toMatchObject({ ok: false, failure: { reason: 'notMacOS' } })
    expect(spawns()).toHaveLength(0)
  })

  it('junk and an oversized line on stdout are skipped, not fatal', async () => {
    const { supervisor } = harness('noisy')
    expect((await supervisor.hello()).ok).toBe(true)
    expect((await supervisor.call('displayStats', { udid: UDID })).ok).toBe(true)
  })

  it('stop ends the helper, and later calls say stopped', async () => {
    const { supervisor } = harness('ok')
    const hello = await supervisor.hello()
    const pid = hello.ok ? hello.value.helper.pid : -1
    await supervisor.stop()
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await supervisor.call('displayStats', { udid: UDID })).toMatchObject({
      ok: false,
      failure: { reason: 'stopped' }
    })
  })

  it('backs off 1, 2, 3 for a helper that keeps dying, and starts over after one that lived', async () => {
    const attempts: number[] = []
    const { supervisor, spawns } = harness(
      { mode: 'crashAlways', liveOnSpawns: [4], liveMs: 300 },
      {
        stableAfterMs: 150,
        restartDelayMs: (attempt) => {
          attempts.push(attempt)
          return 20
        }
      }
    )
    supervisor.start()
    await until(() => attempts.length >= 5)
    // Spawns 1 to 3 die at start; 4 passes hello and lives past stableAfterMs; 5 dies at start.
    expect(attempts.slice(0, 5)).toEqual([1, 2, 3, 1, 2])
    expect(spawns().length).toBeGreaterThanOrEqual(5)
  })

  it('stop() while a restart is pending spawns nothing more', async () => {
    const { supervisor, spawns } = harness('crashAlways', { restartDelayMs: () => 200 })
    supervisor.start()
    await until(() => supervisor.state().state === 'restarting')
    await supervisor.stop()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(spawns()).toHaveLength(1)
    expect(supervisor.state()).toEqual({ state: 'stopped' })
  })

  it('the helper gets an allowlisted environment plus the chosen options, never an inherited POD_SIM_*', async () => {
    const source = {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      HOME: '/Users/someone',
      TMPDIR: '/var/folders/xy/T/',
      DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
      LANG: 'pl_PL.UTF-8',
      LC_CTYPE: 'UTF-8',
      AWS_SECRET_ACCESS_KEY: 'not for the helper',
      POD_SIM_FORCE_UNKNOWN_BUILD: '1',
      POD_SIM_DEVICE_SET: '/tmp/left-in-a-shell',
      POD_SIM_VERSION_TABLE: '/tmp/left-in-a-shell.json',
      POD_SIM_TOKEN: 'a token from somewhere else'
    }
    const plain = harness('ok', { env: source, versionTablePath: '/opt/pod/table.json' })
    expect((await plain.supervisor.hello()).ok).toBe(true)
    const env = plain.envOf(1)
    expect(env).toMatchObject({
      PATH: source.PATH,
      HOME: '/Users/someone',
      TMPDIR: '/var/folders/xy/T/',
      DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
      LANG: 'pl_PL.UTF-8',
      LC_CTYPE: 'UTF-8',
      POD_SIM_VERSION_TABLE: '/opt/pod/table.json',
      POD_SIM_TOKEN: plain.spawns()[0]?.token
    })
    for (const key of [
      'AWS_SECRET_ACCESS_KEY',
      'POD_SIM_FORCE_UNKNOWN_BUILD',
      'POD_SIM_DEVICE_SET'
    ]) {
      expect(env).not.toHaveProperty(key)
    }

    const drill = harness('ok', {
      env: source,
      deviceSet: '/private/tmp/pod-sim-probe-set',
      forceUnknownBuild: true
    })
    expect((await drill.supervisor.hello()).ok).toBe(true)
    expect(drill.envOf(1)).toMatchObject({
      POD_SIM_DEVICE_SET: '/private/tmp/pod-sim-probe-set',
      POD_SIM_FORCE_UNKNOWN_BUILD: '1'
    })
    expect(drill.envOf(1)).not.toHaveProperty('POD_SIM_VERSION_TABLE')
  })

  it('every spawn gets a token of its own', async () => {
    const { supervisor, spawns } = harness('crashOnce')
    await supervisor.call('screenshot', { udid: UDID, path: '/tmp/a.png' })
    expect((await supervisor.call('screenshot', { udid: UDID, path: '/tmp/b.png' })).ok).toBe(true)
    const tokens = spawns().map((spawn) => spawn.token)
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens[1]).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it.each([
    ['wrongToken', 'tokenMismatch'],
    ['wrongProtocol', 'protocolMismatch']
  ])(
    'a helper refusing with %s is not respawned until its binary changes',
    async (mode, reason) => {
      const { supervisor, spawns, binary } = harness(mode)
      expect(await supervisor.hello()).toMatchObject({ ok: false, failure: { reason } })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(supervisor.state()).toMatchObject({ state: 'unavailable', failure: { reason } })
      // The pool may call start() again; the same build is not spawned for it either.
      supervisor.start()
      expect(supervisor.state()).toMatchObject({ state: 'unavailable', failure: { reason } })
      expect(await supervisor.call('displayStats', { udid: UDID })).toMatchObject({
        ok: false,
        failure: { reason }
      })
      expect(spawns()).toHaveLength(1)

      // A new build at the same path (another size and mtime) is tried again on the next call.
      writeFileSync(binary, `${readFileSync(binary, 'utf8')}// rebuilt\n`)
      expect(await supervisor.call('displayStats', { udid: UDID })).toMatchObject({
        ok: false,
        failure: { reason }
      })
      expect(spawns()).toHaveLength(2)
    }
  )

  it('backs off from 250 ms, doubling, to a 30 s ceiling', () => {
    expect([1, 2, 3, 7, 8, 20].map(simHelperRestartDelayMs)).toEqual([
      250, 500, 1_000, 16_000, 30_000, 30_000
    ])
  })
})
