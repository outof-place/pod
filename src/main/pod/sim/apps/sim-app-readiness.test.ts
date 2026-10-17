// The app module end to end on this Mac: real files in a throwaway simulator home, real detached
// builds and Metro processes (tiny shell and node stand-ins), a device kept in memory.
import { createServer, type Server } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simRefusal } from '../../../../shared/pod-sim/sim-refusals'
import { probeSimMetro } from './sim-app-metro-http'
import type { SimApps } from './sim-app-readiness'
import {
  appsFor,
  BUNDLE,
  DEVICE,
  eventually,
  fakeBuildCommand,
  fakeDevice,
  sandbox,
  scriptedFingerprints,
  thisRuntime,
  worktree,
  writeLeases,
  type FakeDevice,
  type Sandbox
} from './sim-app.test-support'
import type { SimRuntime } from '../pool/sim-pool-ports'

const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE || 'node'
const FAKE_METRO = join(__dirname, '__fixtures__', 'fake-metro.cjs')

let box: Sandbox
let self: SimRuntime
let device: FakeDevice
let counter: string
const finished: { buildId: string; ok: boolean }[] = []
const started: SimApps[] = []

/** A free TCP port with 1100 free-looking ports above it (the worktree range). */
async function freeBase(): Promise<number> {
  for (;;) {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    const answers = await Promise.all(
      [base, base + 100, base + 101, base + 102].map((port) => probeSimMetro(port, '/nowhere', 300))
    )
    if (answers.every((answer) => answer === 'none')) {
      return base
    }
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end('HTTP/1.1 200 OK\r\n\r\nnot metro'))
    server.listen(port, () => resolve(server))
  })
}

beforeEach(async () => {
  box = await sandbox()
  self = await thisRuntime()
  device = fakeDevice()
  counter = join(box.dir, 'builds-run')
  finished.length = 0
})

afterEach(async () => {
  // Stop every Metro a test left: no lease, no grace.
  for (const apps of started.splice(0)) {
    await writeLeases(box.home, self, [])
    await apps.reconcile()
    await apps.reconcile()
  }
  await box.cleanup()
})

function make(fingerprints = scriptedFingerprints(), graceMs = 0): SimApps {
  const apps = appsFor(box, self, {
    device,
    shell: fingerprints.shell,
    metroGraceMs: graceMs,
    connectMs: 400,
    onBuildFinished: (buildId, ok) => finished.push({ buildId, ok })
  })
  started.push(apps)
  return apps
}

const buildRecipe = (extra = '') =>
  [
    'fingerprint: fingerprint-cli',
    'build:',
    `  command: ${JSON.stringify(fakeBuildCommand('build/Pod.app', counter, extra))}`,
    '  output: build/*.app'
  ].join('\n')

async function builds(): Promise<number> {
  return existsSync(counter) ? (await readFile(counter, 'utf8')).trim().split('\n').length : 0
}

describe.skipIf(process.platform !== 'darwin')('the right dev client for a worktree', () => {
  it('builds once for two worktrees missing the same fingerprint at once; the second joins', async () => {
    const recipe = { app: buildRecipe('sleep 0.4') }
    const a = await worktree(box, 'wt-a', recipe)
    const b = await worktree(box, 'wt-b', recipe)
    const apps = make()
    const [first, second] = await Promise.all([
      apps.prepare({ worktreeRoot: a }),
      apps.prepare({ worktreeRoot: b })
    ])
    expect(first.ok && first.client.state).toBe('building')
    expect(second.ok && second.client.state).toBe('building')
    const id = first.ok && first.client.state === 'building' ? first.client.buildId : ''
    expect(second.ok && second.client.state === 'building' && second.client.buildId).toBe(id)
    // While it runs, a waiting lease sees which build, and its phase from the log.
    await writeLeases(box.home, self, [[a, 'app', id]])
    const running = await apps.build(id)
    expect(running).toMatchObject({
      buildId: id,
      bundleId: BUNDLE,
      state: 'building',
      waiting: ['sl_test0']
    })
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    expect(finished).toEqual([{ buildId: id, ok: true }])
    expect(await builds()).toBe(1)
    // A third worktree with that fingerprint installs from the cache: no build.
    const c = await worktree(box, 'wt-c', recipe)
    const third = await apps.prepare({ worktreeRoot: c })
    expect(third.ok && third.client).toEqual({
      state: 'cached',
      path: join(box.home.root, 'clients', BUNDLE, 'f00d.app')
    })
    expect(await builds()).toBe(1)
    // The lease that waited on it hears the build is done when the pool reconciles.
    expect(await apps.reconcile()).toEqual([{ kind: 'buildFinished', buildId: id, ok: true }])
  }, 20_000)

  it('builds nothing for a second worktree whose fingerprint has a client already', async () => {
    const recipe = { app: buildRecipe() }
    const a = await worktree(box, 'wt-a', recipe)
    const apps = make()
    const first = await apps.prepare({ worktreeRoot: a })
    expect(first.ok && first.client.state).toBe('building')
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    const b = await worktree(box, 'wt-b', recipe)
    const again = await Promise.all([
      apps.prepare({ worktreeRoot: a }),
      apps.prepare({ worktreeRoot: b })
    ])
    expect(again.map((answer) => answer.ok && answer.client.state)).toEqual(['cached', 'cached'])
    expect(await builds()).toBe(1)
  }, 20_000)

  it('adopts the recipe’s external client cache instead of building, and leaves that cache as it was', async () => {
    const external = join(box.external, 'f00d.app')
    await mkdir(external, { recursive: true })
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE}</string></dict></plist>`
    await writeFile(join(external, 'Info.plist'), plist)
    await writeFile(join(external, 'main.jsbundle-free-binary'), 'x'.repeat(4096))
    const root = await worktree(box, 'wt-a', {
      app: `${buildRecipe()}\nclientCache: ${JSON.stringify(box.external)}`
    })
    const apps = make()
    const answer = await apps.prepare({ worktreeRoot: root })
    const cached = join(box.home.root, 'clients', BUNDLE, 'f00d.app')
    expect(answer.ok && answer.client).toEqual({ state: 'cached', path: cached })
    expect(await builds()).toBe(0)
    expect(await readFile(join(cached, 'main.jsbundle-free-binary'), 'utf8')).toHaveLength(4096)
    expect(await readFile(join(external, 'Info.plist'), 'utf8')).toBe(plist)
    expect(
      JSON.parse(await readFile(join(box.home.root, 'clients', BUNDLE, 'f00d.json'), 'utf8'))
    ).toMatchObject({
      source: `external:${box.external}`
    })
  })

  it('does not adopt an external client of another bundle id', async () => {
    const external = join(box.external, 'f00d.app')
    await mkdir(external, { recursive: true })
    await writeFile(
      join(external, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>'
    )
    const root = await worktree(box, 'wt-a', {
      app: `fingerprint: fp\nclientCache: ${JSON.stringify(box.external)}`
    })
    const answer = await make().prepare({ worktreeRoot: root })
    expect(answer.ok && answer.client.state).toBe('missing')
  })

  it('answers a failed build with its log tail, retries once, then stops building it', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe("echo 'error: no such module ExpoModulesCore' && exit 65")
    })
    const apps = make()
    const first = await apps.prepare({ worktreeRoot: root })
    const id = first.ok && first.client.state === 'building' ? first.client.buildId : ''
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    expect(finished).toEqual([{ buildId: id, ok: false }])
    const failed = await apps.buildRefusal(id, 'app')
    expect(failed).toMatchObject({
      code: 'build_failed',
      buildId: id,
      logPath: join(box.home.root, 'clients', 'logs', `${id}.log`),
      app: 'app',
      logTail: expect.stringContaining('error: no such module ExpoModulesCore')
    })
    // An explicit lease again (a flake, a fix outside the native code) gets one more try.
    const second = await apps.prepare({ worktreeRoot: root })
    expect(second.ok && second.client.state).toBe('building')
    await eventually(
      async () => finished,
      (list) => list.length === 2
    )
    // Then no more: every lease is refused with the tail and the wait, and nothing builds.
    for (let call = 0; call < 3; call += 1) {
      const refused = await apps.prepare({ worktreeRoot: root })
      expect(refused.ok).toBe(false)
      if (!refused.ok) {
        expect(refused.refusal).toMatchObject({ code: 'build_failed', retryInMinutes: 10 })
        expect(simRefusal(refused.refusal).message).toMatch(
          /It ended with: .*error: no such module ExpoModulesCore.* Pod builds this fingerprint again in 10 min/
        )
      }
    }
    expect(await builds()).toBe(2)
    const snapshot = await apps.builds()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({
      state: 'failed',
      failure: { message: expect.stringContaining('exited 65') }
    })
  }, 20_000)

  it('starts a new build when the runtime that wrote one died before starting it', async () => {
    const root = await worktree(box, 'wt-a', { app: buildRecipe() })
    // A peer wrote the build and died before its process started.
    await mkdir(join(box.home.root, 'clients'), { recursive: true })
    await writeFile(
      join(box.home.root, 'clients', 'builds.json'),
      JSON.stringify({
        version: 1,
        builds: [
          {
            buildId: 'sb_app_f00d_dead',
            appId: 'app',
            bundleId: BUNDLE,
            fingerprint: 'f00d',
            worktreeRoot: root,
            appDir: join(root, 'apps', 'app'),
            output: 'build/*.app',
            command: 'true',
            state: 'building',
            startedAt: Date.now(),
            by: { pid: 1, startedAt: 1 },
            logPath: join(box.dir, 'dead.log'),
            statusPath: join(box.dir, 'dead.status'),
            failures: 0
          }
        ]
      })
    )
    const apps = appsFor(box, self, {
      device,
      shell: scriptedFingerprints().shell,
      runtimeState: async () => 'exited',
      onBuildFinished: (buildId, ok) => finished.push({ buildId, ok })
    })
    const answer = await apps.prepare({ worktreeRoot: root })
    expect(answer.ok && answer.client.state === 'building' && answer.client.buildId).not.toBe(
      'sb_app_f00d_dead'
    )
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    expect(await builds()).toBe(1)
  }, 20_000)

  it('refuses a worktree on an SSH host, and one that is not a folder here', async () => {
    const apps = make()
    const remote = await apps.prepare({
      worktreeRoot: '/home/dev/portivo',
      remoteHost: 'build-box'
    })
    expect(remote).toEqual({
      ok: false,
      refusal: {
        code: 'unavailable',
        problem:
          'simulators and dev-client builds run on the Mac that runs Pod; /home/dev/portivo is on build-box.'
      }
    })
    const missing = await apps.prepare({ worktreeRoot: join(box.dir, 'gone') })
    expect(!missing.ok && missing.refusal.code).toBe('unavailable')
  })

  it('refuses a bad recipe with its file and key, and a worktree without one', async () => {
    const bad = await worktree(box, 'wt-bad', { file: 'pod.yaml', app: 'metro:\n  port: 80' })
    const none = await worktree(box, 'wt-none', null)
    const apps = make()
    expect(await apps.prepare({ worktreeRoot: bad })).toMatchObject({
      ok: false,
      refusal: {
        code: 'bad_recipe',
        file: join(bad, 'pod.yaml'),
        path: 'simulators.apps.app.metro.port'
      }
    })
    expect(await apps.prepare({ worktreeRoot: none })).toMatchObject({
      ok: false,
      refusal: { code: 'no_recipe', worktreeRoot: none }
    })
  })
})

describe.skipIf(process.platform !== 'darwin')('a worktree’s own Metro', () => {
  const metroRecipe = (base: number) =>
    [
      'fingerprint: fp',
      'metro:',
      `  port: ${base}`,
      `  command: ${JSON.stringify(`'${NODE}' '${FAKE_METRO}' {port}`)}`
    ].join('\n')

  it('gets a port per worktree that differs between worktrees and holds across calls and restarts', async () => {
    const base = await freeBase()
    const recipe = { app: metroRecipe(base) }
    const main = await worktree(box, null, recipe)
    const a = await worktree(box, 'wt-a', recipe)
    const b = await worktree(box, 'wt-b', recipe)
    const apps = make()
    const ports = async (instance: SimApps) => {
      const answers: (number | null | undefined)[] = []
      for (const root of [main, a, b]) {
        const answer = await instance.prepare({ worktreeRoot: root })
        answers.push(answer.ok ? answer.metro?.port : null)
      }
      return answers
    }
    const first = await ports(apps)
    expect(first).toEqual([base, base + 100, base + 101])
    expect(await ports(apps)).toEqual(first)
    // Another runtime (a restart, or a probe's) reads the same plan.
    expect(await ports(make())).toEqual(first)
  }, 30_000)

  it('skips a port another program holds, and moves off one taken since', async () => {
    const base = await freeBase()
    const blocker = await listen(base + 100)
    try {
      const a = await worktree(box, 'wt-a', { app: metroRecipe(base) })
      const apps = make()
      const answer = await apps.prepare({ worktreeRoot: a })
      expect(answer.ok && answer.metro?.port).toBe(base + 101)
    } finally {
      blocker.close()
    }
  }, 30_000)

  it('starts Metro once, warms its bundle, opens the app on it, and stops it after the worktree’s last lease ends', async () => {
    const base = await freeBase()
    const a = await worktree(box, 'wt-a', {
      app: [
        metroRecipe(base),
        'appDefaults:',
        '  EXDevMenuIsOnboardingFinished: true',
        '  EXDevMenuShowsAtLaunch: false'
      ].join('\n')
    })
    // Its client is in the cache already.
    const client = join(box.home.root, 'clients', BUNDLE, 'f00d.app')
    await mkdir(client, { recursive: true })
    await writeFile(
      join(client, 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE}</string></dict></plist>`
    )
    const apps = make(scriptedFingerprints(), 0)
    const prepared = await apps.prepare({ worktreeRoot: a })
    expect(prepared.ok && prepared.metro).toMatchObject({
      port: base + 100,
      running: false,
      startedByPod: true
    })
    // A second lease call while it starts does not start another.
    const again = await apps.prepare({ worktreeRoot: a })
    expect(again.ok && again.metro?.port).toBe(base + 100)

    const appDir = join(a, 'apps', 'app')
    // Once ready, Metro is asked for the bundle the manifest names, once for both lease calls.
    const bundles = join(appDir, 'bundle-requests.log')
    await eventually(
      () => readFile(bundles, 'utf8').catch(() => ''),
      (text) => text !== ''
    )
    expect(await readFile(bundles, 'utf8')).toBe('?platform=ios&dev=true\n')

    const opened = await apps.open({ worktreeRoot: a, udid: DEVICE })
    // Done once the app's JS is on the worktree's Metro, which lists it for this device.
    expect(opened).toMatchObject({
      ok: true,
      metroPort: base + 100,
      installed: true,
      launched: true,
      connected: true
    })
    expect(device.installs).toEqual([client])
    // The recipe's defaults ride along as `-Key value`, which UserDefaults reads over its own.
    expect(device.launches).toEqual([
      [
        '--initialUrl',
        `http://127.0.0.1:${base + 100}`,
        '-EXDevMenuIsOnboardingFinished',
        'YES',
        '-EXDevMenuShowsAtLaunch',
        'NO'
      ]
    ])
    expect(await probeSimMetro(base + 100, appDir)).toBe('ready')
    // Same Metro process: open does not warm it again.
    expect(await readFile(bundles, 'utf8')).toBe('?platform=ios&dev=true\n')
    const [logName] = await readdir(join(box.home.root, 'metro'))
    expect(await readFile(join(box.home.root, 'metro', logName), 'utf8')).toContain(
      `on port ${base + 100}`
    )

    // The app already runs on this worktree's Metro: a second open neither installs nor relaunches.
    const warm = await apps.open({ worktreeRoot: a, udid: DEVICE })
    expect(warm).toMatchObject({ ok: true, installed: false, launched: false, connected: true })
    // `podx sim open` asks for a relaunch: no install, one more launch.
    const relaunched = await apps.open({ worktreeRoot: a, udid: DEVICE, relaunch: true })
    expect(relaunched).toMatchObject({ ok: true, installed: false, launched: true })
    expect(device.installs).toHaveLength(1)
    expect(device.launches).toHaveLength(2)

    // A live lease keeps it; with none left, the grace (0 here) passes and it stops.
    await writeLeases(box.home, self, [[a, 'app']])
    await apps.reconcile()
    await apps.reconcile()
    expect(await probeSimMetro(base + 100, appDir)).toBe('ready')
    await writeLeases(box.home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    await eventually(
      () => probeSimMetro(base + 100, appDir, 300),
      (answer) => answer === 'none'
    )
  }, 30_000)

  it('launches again when a launch stops at the dev launcher, and says so when it never reaches Metro', async () => {
    const base = await freeBase()
    const a = await worktree(box, 'wt-a', { app: metroRecipe(base) })
    const client = join(box.home.root, 'clients', BUNDLE, 'f00d.app')
    await mkdir(client, { recursive: true })
    await writeFile(join(client, 'Info.plist'), '<plist/>')
    const apps = make(scriptedFingerprints(), 0)
    // Its manifest request timed out once: the dev launcher's home, no JS on Metro.
    device.launcherOnly = 1
    const opened = await apps.open({ worktreeRoot: a, udid: DEVICE })
    expect(opened).toMatchObject({ ok: true, launched: true, connected: true })
    expect(device.launches).toHaveLength(2)

    // Running, launched on this Metro, but no longer on it (back at the launcher): launch again.
    await fetch(
      `http://127.0.0.1:${base + 100}/fake/disconnect?appId=${BUNDLE}&deviceName=${device.name}`
    )
    const again = await apps.open({ worktreeRoot: a, udid: DEVICE })
    expect(again).toMatchObject({ ok: true, launched: true, connected: true })
    expect(device.launches).toHaveLength(3)

    // Two launches that never reach Metro: one retry only, and the answer says why.
    device.launcherOnly = 2
    const stuck = await apps.open({ worktreeRoot: a, udid: DEVICE, relaunch: true })
    expect(stuck).toMatchObject({ ok: true, launched: true, connected: false })
    expect(stuck.ok && stuck.problem).toContain('did not reach Metro')
    expect(device.launches).toHaveLength(5)
  }, 30_000)

  it('keeps Metro through the grace after the last lease, for the next lease of the worktree', async () => {
    const base = await freeBase()
    const a = await worktree(box, 'wt-a', { app: metroRecipe(base) })
    const apps = make(scriptedFingerprints(), 60_000)
    await apps.prepare({ worktreeRoot: a })
    const appDir = join(a, 'apps', 'app')
    await eventually(
      () => probeSimMetro(base + 100, appDir),
      (answer) => answer === 'ready'
    )
    await writeLeases(box.home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    expect(await probeSimMetro(base + 100, appDir)).toBe('ready')
    // afterEach stops it: a fresh module with no grace.
    started.push(make(scriptedFingerprints(), 0))
  }, 30_000)
})

describe.skipIf(process.platform !== 'darwin')('the pool’s app port', () => {
  it('reset app uninstalls and reinstalls the lease’s client, reset device installs it again', async () => {
    const a = await worktree(box, 'wt-a', { app: 'fingerprint: fp' })
    const client = join(box.home.root, 'clients', BUNDLE, 'f00d.app')
    await mkdir(client, { recursive: true })
    await writeFile(
      join(client, 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE}</string></dict></plist>`
    )
    await writeLeases(box.home, self, [[a, 'app']])
    const apps = make()
    expect(await apps.open({ worktreeRoot: a, udid: DEVICE })).toMatchObject({
      ok: true,
      installed: true
    })
    await apps.port.reset(DEVICE, 'sl_test0')
    expect(device.installs).toEqual([client, client])
    expect(device.launches).toHaveLength(2)
    // The device was erased: Pod's record of it is gone with it, so it installs again.
    device.apps.clear()
    device.running.clear()
    await apps.port.reinstall(DEVICE, 'sl_test0')
    expect(device.installs).toEqual([client, client, client])
    // No Metro in this recipe: the app launches without an initial URL.
    expect(device.launches.at(-1)).toEqual([])
  })

  it('does nothing for a lease that is gone or has no app', async () => {
    const apps = make()
    await apps.port.reset(DEVICE, 'sl_missing')
    await apps.port.reinstall(DEVICE, 'sl_missing')
    expect(device.installs).toEqual([])
  })
})
