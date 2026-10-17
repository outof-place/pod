// How a dev-client build ends: stopped by claude-acc (not broken), past its time (broken), or done
// with an .app the build rewrote in place; and a fingerprint that does not hold is never built.
import { existsSync } from 'node:fs'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { simRefusal } from '../../../../shared/pod-sim/sim-refusals'
import type { SimRuntime } from '../pool/sim-pool-ports'
import type { SimApps, SimAppsOptions } from './sim-app-readiness'
import type { SimShell } from './sim-app-shell'
import {
  appsFor,
  BUNDLE,
  eventually,
  fakeBuildCommand,
  fakeDevice,
  sandbox,
  scriptedFingerprints,
  thisRuntime,
  worktree,
  type Sandbox
} from './sim-app.test-support'

let box: Sandbox
let self: SimRuntime
let counter: string
const finished: { buildId: string; ok: boolean }[] = []

beforeEach(async () => {
  box = await sandbox()
  self = await thisRuntime()
  counter = join(box.dir, 'builds-run')
  finished.length = 0
})

afterEach(async () => {
  await box.cleanup()
})

function make(extra: Partial<SimAppsOptions> = {}): SimApps {
  return appsFor(box, self, {
    device: fakeDevice(),
    shell: scriptedFingerprints().shell,
    onBuildFinished: (buildId, ok) => finished.push({ buildId, ok }),
    ...extra
  })
}

const buildRecipe = (command: string) =>
  [
    'fingerprint: fp',
    'build:',
    `  command: ${JSON.stringify(command)}`,
    '  output: build/*.app'
  ].join('\n')

async function builds(): Promise<number> {
  return existsSync(counter) ? (await readFile(counter, 'utf8')).trim().split('\n').length : 0
}

const BuildsFile = z.object({
  builds: z.array(
    z.looseObject({ buildId: z.string(), process: z.object({ pid: z.number() }).optional() })
  )
})

/**
 * The build's pid once its record holds it: the runtime writes it after `ps` answers, and a clock
 * moved past a minute before that reads a build that never started.
 */
async function recordedPid(id: string): Promise<number> {
  const path = join(box.home.root, 'clients', 'builds.json')
  const build = await eventually(
    async () =>
      BuildsFile.parse(JSON.parse(await readFile(path, 'utf8'))).builds.find(
        (other) => other.buildId === id
      ),
    (found) => found?.process !== undefined
  )
  return build?.process?.pid ?? 0
}

/** The history of this app's last good build. */
async function lastGoodBuild(ms: number): Promise<void> {
  await mkdir(join(box.home.root, 'clients'), { recursive: true })
  await writeFile(
    join(box.home.root, 'clients', 'builds.json'),
    JSON.stringify({ version: 1, builds: [], history: { [BUNDLE]: { steps: 1, ms } } })
  )
}

/**
 * Prepares, and answers the build it started once it ended. A build that ends before prepare reads
 * it back (a stop within milliseconds) is answered as its own refusal.
 */
async function buildOnce(apps: SimApps, root: string): Promise<string> {
  const answer = await apps.prepare({ worktreeRoot: root })
  const id = answer.ok
    ? answer.client.state === 'building'
      ? answer.client.buildId
      : ''
    : answer.refusal.code === 'build_failed'
      ? answer.refusal.buildId
      : ''
  expect(id, JSON.stringify(answer)).not.toBe('')
  await eventually(
    async () => finished,
    (list) => list.some((one) => one.buildId === id)
  )
  return id
}

describe.skipIf(process.platform !== 'darwin')('how a dev-client build ends', () => {
  it('takes a build claude-acc stopped (cancel, dequeue, brake) as stopped: no failure counted', async () => {
    const how = join(box.dir, 'how.sh')
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(`echo built >> '${counter}' && echo '› Compiling app' && . '${how}'`)
    })
    const apps = make()
    const endings = [
      // `claude-acc sched cancel` while it waited for memory (sched.py EXIT_CANCELLED).
      "echo '[sched] anulowane po 3s w kolejce (claude-acc sched cancel)' >&2; exit 130",
      // The memory brake or a cancel while it ran: SIGTERM, then SIGKILL, to its process group.
      'kill -TERM $$',
      'kill -KILL $$',
      // Its whole group killed, the wrapper that records the exit code included.
      'kill -KILL $PPID; sleep 0.2'
    ]
    for (const ending of endings) {
      await writeFile(how, `${ending}\n`)
      const id = await buildOnce(apps, root)
      expect(finished.at(-1)).toEqual({ buildId: id, ok: false })
      const refusal = await apps.buildRefusal(id, 'app')
      expect(refusal).toMatchObject({ code: 'build_failed', buildId: id })
      expect(refusal && 'retryInMinutes' in refusal ? refusal.retryInMinutes : undefined).toBe(
        undefined
      )
      const message = refusal ? simRefusal(refusal).message : ''
      expect(message).toContain('was stopped before it finished')
      expect(message).not.toContain('Fix the build')
    }
    // Four stops in a row, and the next lease still builds: nothing counted toward the backoff.
    expect(await builds()).toBe(4)
    await writeFile(how, 'true\n')
    const again = await apps.prepare({ worktreeRoot: root })
    expect(again.ok ? {} : again.refusal).not.toHaveProperty('retryInMinutes')
    await eventually(builds, (count) => count === 5)
  }, 60_000)

  it('stops a build past 3x its app’s last good build, and fails it with its log', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(`echo built >> '${counter}' && echo '› Compiling stuck-module' && sleep 30`)
    })
    // The last good build of this app took 10 s: its cap is 30 s, with room for a loaded Mac.
    await lastGoodBuild(10_000)
    const clock = { skew: 0 }
    const apps = make({ now: () => Date.now() + clock.skew })
    const answer = await apps.prepare({ worktreeRoot: root })
    const id = answer.ok && answer.client.state === 'building' ? answer.client.buildId : ''
    await eventually(
      () => readFile(join(box.home.root, 'clients', 'logs', `${id}.log`), 'utf8'),
      // A line of its own: the log's second line echoes the whole command.
      (log) => log.includes('\n› Compiling stuck-module')
    )
    const pid = await recordedPid(id)
    expect((await apps.build(id))?.state).toBe('building')
    clock.skew = 15_000
    await apps.reconcile()
    expect(await apps.build(id)).toMatchObject({ state: 'building' })
    clock.skew = 31_000
    await apps.reconcile()
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    expect(finished).toEqual([{ buildId: id, ok: false }])
    expect(() => process.kill(pid, 0)).toThrow()
    const refusal = await apps.buildRefusal(id, 'app')
    const message = refusal ? simRefusal(refusal).message : ''
    expect(message).toMatch(/ran past 30 s \(3x the last good build\)/)
    expect(message).toContain('stuck-module')
  }, 30_000)

  it('stops a build with no good build to go by after 60 minutes', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(`echo built >> '${counter}' && sleep 30`)
    })
    const clock = { skew: 0 }
    const apps = make({ now: () => Date.now() + clock.skew })
    const answer = await apps.prepare({ worktreeRoot: root })
    const id = answer.ok && answer.client.state === 'building' ? answer.client.buildId : ''
    await recordedPid(id)
    clock.skew = 59 * 60_000
    await apps.reconcile()
    expect(await apps.build(id)).toMatchObject({ state: 'building' })
    clock.skew = 61 * 60_000
    await apps.reconcile()
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    const refusal = await apps.buildRefusal(id, 'app')
    expect(refusal ? simRefusal(refusal).message : '').toContain('ran past 60 min')
  }, 30_000)

  // claude-acc's own line once a build leaves its queue (sched.py: `start po {human_s} czekania`).
  const leftQueue = (wait: string) => `echo '[sched] start po ${wait} czekania, local' >&2`

  it('counts a build’s time from when claude-acc let it start, not from its wait in the queue', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(
        `echo built >> '${counter}' && ${leftQueue('1m')} && echo '› Compiling app' && sleep 30`
      )
    })
    await lastGoodBuild(10_000)
    const clock = { skew: 0 }
    const apps = make({ now: () => Date.now() + clock.skew })
    const answer = await apps.prepare({ worktreeRoot: root })
    const id = answer.ok && answer.client.state === 'building' ? answer.client.buildId : ''
    await eventually(
      () => readFile(join(box.home.root, 'clients', 'logs', `${id}.log`), 'utf8'),
      (log) => log.includes('\n› Compiling app')
    )
    await recordedPid(id)
    // 61 s since the lease, 60 of them in claude-acc's queue: about 1 s of its 30 s.
    clock.skew = 61_000
    await apps.reconcile()
    expect((await apps.build(id))?.failure).toBeUndefined()
    expect(await apps.build(id)).toMatchObject({ state: 'building' })
    expect(finished).toEqual([])
    clock.skew = 91_000
    await apps.reconcile()
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    const refusal = await apps.buildRefusal(id, 'app')
    expect(refusal ? simRefusal(refusal).message : '').toMatch(/ran past 30 s/)
  }, 30_000)

  it('stops a build that left the queue and then hangs before its first step', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(`echo built >> '${counter}' && ${leftQueue('3s')} && sleep 30`)
    })
    const clock = { skew: 0 }
    const apps = make({ now: () => Date.now() + clock.skew })
    const answer = await apps.prepare({ worktreeRoot: root })
    const id = answer.ok && answer.client.state === 'building' ? answer.client.buildId : ''
    await eventually(
      () => readFile(join(box.home.root, 'clients', 'logs', `${id}.log`), 'utf8'),
      (log) => log.includes('\n[sched] start po')
    )
    await recordedPid(id)
    // Out of the queue, so neither queued in the snapshot nor exempt from the cap.
    expect(await apps.build(id)).toMatchObject({ state: 'building' })
    clock.skew = 61 * 60_000
    await apps.reconcile()
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )
    const refusal = await apps.buildRefusal(id, 'app')
    expect(refusal ? simRefusal(refusal).message : '').toContain('ran past 60 min')
  }, 30_000)

  it('takes the .app a build rewrote in place, whose folder kept its old time', async () => {
    const out = 'build/Pod.app'
    const root = await worktree(box, 'wt-a', { app: buildRecipe(fakeBuildCommand(out, counter)) })
    // A previous build's .app: the next incremental build rewrites its files, not the folder.
    const app = join(root, 'apps', 'app', out)
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'Info.plist'), 'old')
    const past = new Date(Date.now() - 3_600_000)
    await utimes(join(app, 'Info.plist'), past, past)
    await utimes(app, past, past)
    const apps = make()
    const id = await buildOnce(apps, root)
    expect(finished).toEqual([{ buildId: id, ok: true }])
    expect(existsSync(join(box.home.root, 'clients', BUNDLE, 'f00d.app', 'Info.plist'))).toBe(true)
  }, 20_000)

  it('builds nothing for a fingerprint that comes out different when run again', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(fakeBuildCommand('build/Pod.app', counter))
    })
    // @expo/fingerprint swallows a config that failed to load: the hash flips between runs.
    const hashes = ['f00d', 'beef']
    let calls = 0
    const shell: SimShell = async () => {
      const hash = hashes[calls % 2]
      calls += 1
      return { ok: true, code: 0, stdout: JSON.stringify({ sources: [], hash }), stderr: '' }
    }
    const answer = await make({ shell }).prepare({ worktreeRoot: root })
    expect(answer.ok && answer.client).toMatchObject({
      state: 'missing',
      why: expect.stringContaining('f00d, then beef')
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await builds()).toBe(0)
  })

  it('runs the fingerprint a second time only before it would start a build', async () => {
    const root = await worktree(box, 'wt-a', {
      app: buildRecipe(fakeBuildCommand('build/Pod.app', counter))
    })
    const fingerprints = scriptedFingerprints()
    const apps = make({ shell: fingerprints.shell })
    await buildOnce(apps, root)
    expect(fingerprints.calls).toHaveLength(2)
    // Its client is cached now: one run (or none, kept) per lease.
    const b = await worktree(box, 'wt-b', {
      app: buildRecipe(fakeBuildCommand('build/Pod.app', counter))
    })
    expect((await apps.prepare({ worktreeRoot: b })).ok).toBe(true)
    expect(fingerprints.calls).toHaveLength(3)
    expect(await builds()).toBe(1)
  }, 20_000)
})
