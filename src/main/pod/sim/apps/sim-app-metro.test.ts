// The bundle warm-up against a stand-in Expo Metro: one bundle request per Metro process, shared by
// callers while in flight, and a new one after Metro restarts (a new process starts cold).
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import { createSimProcessFacts } from '../adapters/sim-process-facts'
import type { SimRuntime } from '../pool/sim-pool-ports'
import { createSimMetros, type SimMetros } from './sim-app-metro'
import { probeSimMetro, simAppOnMetro } from './sim-app-metro-http'
import { simAppHome } from './sim-app-paths'
import { createSimProcessControl, simSpawnDetached } from './sim-app-spawn'
import { sandbox, thisRuntime, worktree, type Sandbox } from './sim-app.test-support'

const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE || 'node'
const FAKE_METRO = join(__dirname, '__fixtures__', 'fake-metro.cjs')

let box: Sandbox
let self: SimRuntime
let metros: SimMetros
// No worktree uses its Metro: with no grace, one pass marks a Metro idle and the next stops it.
const noLeases = () => new Set<string>()

beforeEach(async () => {
  box = await sandbox()
  self = await thisRuntime()
  metros = createSimMetros({
    home: simAppHome(box.home),
    spawn: simSpawnDetached,
    control: createSimProcessControl(createSimProcessFacts()),
    self,
    graceMs: 0
  })
})

afterEach(async () => {
  await metros.reconcile(noLeases())
  await metros.reconcile(noLeases())
  await box.cleanup()
})

describe.skipIf(process.platform !== 'darwin')('warming a worktree’s Metro', () => {
  it('asks once per Metro process, shares a warm-up in flight, and asks again after a restart', async () => {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    const app: SimRecipeApp = {
      bundleId: 'com.example.podsim',
      path: 'apps/app',
      metro: { port: base, command: `'${NODE}' '${FAKE_METRO}' {port}` }
    }
    const root = await worktree(box, 'wt-a', {})
    const input = { worktreeRoot: root, appId: 'app', app }
    const bundles = join(root, 'apps', 'app', 'bundle-requests.log')
    const requests = async () =>
      (await readFile(bundles, 'utf8').catch(() => '')).split('\n').filter(Boolean)

    const started = await metros.ensure(input, { start: true })
    expect(started).toMatchObject({ ok: true, started: true })
    const [first, joined] = await Promise.all([metros.warm(input), metros.warm(input)])
    expect(first).toMatchObject({ ok: true })
    expect(joined).toBe(first)
    expect(await requests()).toEqual(['?platform=ios&dev=true'])
    // The same Metro process has it built: nothing to ask.
    expect(await metros.warm(input)).toBeNull()
    expect(await requests()).toHaveLength(1)

    // Metro restarts (stopped once idle, started by the next lease): its first bundle is cold again.
    await metros.reconcile(noLeases())
    await metros.reconcile(noLeases())
    const port = started.ok ? started.port : 0
    expect(await probeSimMetro(port, join(root, 'apps', 'app'), 500)).toBe('none')
    expect(await metros.ensure(input, { start: true })).toMatchObject({ ok: true, started: true })
    expect(await metros.warm(input)).toMatchObject({ ok: true })
    expect(await requests()).toHaveLength(2)
  }, 30_000)
})

describe('whether the app’s JS is on Metro', () => {
  /** A Metro stand-in whose inspector list answers as `reply` says. */
  async function inspector(reply: (res: ServerResponse) => void) {
    const server: Server = createServer((_req, res) => reply(res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    return { port, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  it('finds the app on this device only, and tells no list from a Metro too busy to answer', async () => {
    const pages = [{ appId: 'eu.portivo.app', deviceName: 'Portivo-Pod-1' }]
    const listing = await inspector((res) => res.end(JSON.stringify(pages)))
    const none = await inspector((res) => {
      res.statusCode = 404
      res.end()
    })
    // Busy: answers after the caller stopped waiting.
    const busy = await inspector((res) => setTimeout(() => res.end('[]'), 1_000))
    try {
      expect(await simAppOnMetro(listing.port, 'eu.portivo.app', 'Portivo-Pod-1')).toBe(true)
      expect(await simAppOnMetro(listing.port, 'eu.portivo.app', 'Portivo-Pod-2')).toBe(false)
      expect(await simAppOnMetro(listing.port, 'eu.portivo.operator', null)).toBe(false)
      expect(await simAppOnMetro(none.port, 'eu.portivo.app', null)).toBe('noList')
      expect(await simAppOnMetro(busy.port, 'eu.portivo.app', null, 200)).toBe('noAnswer')
    } finally {
      await Promise.all([listing.close(), none.close(), busy.close()])
    }
  })
})
