// A loaded Mac: `ps` times out (the process facts answer `unknown`) while the build and Metro run.
// Busy is not gone: the build stays one build, the Metro record keeps its process, the port stays.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSimProcessFacts, type SimProcessFacts } from '../adapters/sim-process-facts'
import type { SimRuntime } from '../pool/sim-pool-ports'
import { probeSimMetro } from './sim-app-metro-http'
import type { SimApps } from './sim-app-readiness'
import {
  appsFor,
  DEVICE,
  eventually,
  fakeBuildCommand,
  fakeDevice,
  freeBase,
  metroRecipe,
  sandbox,
  scriptedFingerprints,
  thisRuntime,
  worktree,
  writeLeases,
  type Sandbox
} from './sim-app.test-support'

let box: Sandbox
let self: SimRuntime
let apps: SimApps | null = null
const busy = { now: false }
// The real process table, unless the Mac is too busy for `ps` to answer in time.
const real = createSimProcessFacts()
const processes: SimProcessFacts = {
  startOf: (pid) => (busy.now ? Promise.resolve('unknown') : real.startOf(pid)),
  table: () => real.table()
}

beforeEach(async () => {
  box = await sandbox()
  self = await thisRuntime()
  busy.now = false
})

afterEach(async () => {
  busy.now = false
  if (apps) {
    await writeLeases(box.home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    apps = null
  }
  await box.cleanup()
})

describe.skipIf(process.platform !== 'darwin')('a Mac too busy to read its process table', () => {
  it('keeps one build of a fingerprint while ps cannot say the build runs', async () => {
    const counter = join(box.dir, 'builds-run')
    const recipe = {
      app: [
        'fingerprint: fp',
        'build:',
        `  command: ${JSON.stringify(fakeBuildCommand('build/Pod.app', counter, 'sleep 1'))}`,
        '  output: build/*.app'
      ].join('\n')
    }
    const a = await worktree(box, 'wt-a', recipe)
    const b = await worktree(box, 'wt-b', recipe)
    const finished: string[] = []
    apps = appsFor(box, self, {
      device: fakeDevice(),
      shell: scriptedFingerprints().shell,
      processes,
      metroGraceMs: 0,
      onBuildFinished: (buildId) => finished.push(buildId)
    })
    busy.now = true
    const first = await apps.prepare({ worktreeRoot: a })
    expect(first.ok && first.client.state).toBe('building')
    const id = first.ok && first.client.state === 'building' ? first.client.buildId : ''
    // ps still cannot answer: the second worktree joins the build that runs.
    const second = await apps.prepare({ worktreeRoot: b })
    expect(second.ok && second.client.state === 'building' && second.client.buildId).toBe(id)
    await apps.reconcile()
    const record = await apps.build(id)
    expect(record).toMatchObject({ buildId: id, state: 'building' })
    busy.now = false
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
  }, 30_000)

  it('keeps the Metro it started and its port while ps and Metro are too busy to answer', async () => {
    const base = await freeBase()
    const a = await worktree(box, 'wt-a', { app: metroRecipe(base) })
    const appDir = join(a, 'apps', 'app')
    apps = appsFor(box, self, {
      device: fakeDevice(),
      shell: scriptedFingerprints().shell,
      processes,
      metroGraceMs: 0
    })
    await writeLeases(box.home, self, [{ worktreeRoot: a, appId: 'app', holds: DEVICE }])
    busy.now = true
    const prepared = await apps.prepare({ worktreeRoot: a })
    expect(prepared.ok && prepared.metro?.port).toBe(base + 300)
    await eventually(
      () => probeSimMetro(base + 300, appDir),
      (answer) => answer === 'ready'
    )
    const servers = async () =>
      JSON.parse(await readFile(join(box.home.root, 'metro.json'), 'utf8')).servers
    // Recorded with its process even though ps could not read its start.
    const [started] = await servers()
    expect(started.process.pid).toBeTypeOf('number')

    // Metro itself is busy now (its /status does not answer within the probe's 1.5 s).
    await fetch(`http://127.0.0.1:${base + 300}/fake/busy?ms=4000`)
    const again = await apps.prepare({ worktreeRoot: a })
    expect(again.ok && again.metro?.port).toBe(base + 300)
    // No lease left and no grace, but ps cannot say it runs: Pod neither stops nor forgets it.
    await writeLeases(box.home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    const [kept] = await servers()
    expect(kept).toMatchObject({ port: base + 300, process: { pid: started.process.pid } })
    expect(() => process.kill(started.process.pid, 0)).not.toThrow()

    // ps answers again: the idle Metro stops for real.
    busy.now = false
    await apps.reconcile()
    await apps.reconcile()
    await eventually(
      () => probeSimMetro(base + 300, appDir, 300),
      (answer) => answer === 'none'
    )
  }, 30_000)
})
