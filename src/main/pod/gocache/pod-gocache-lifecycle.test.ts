import {
  chmodSync,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { runPodGoCacheLifecycle } from './pod-gocache-lifecycle'
import {
  UID,
  fakeLaunchd,
  helperVersion,
  lifecycleFixture as fixture,
  removeLifecycleFixtures,
  result,
  writeHelper
} from './pod-gocache-lifecycle-fixture'

afterEach(removeLifecycleFixtures)

describe('pod-gocache lifecycle', () => {
  it('installs the bundled helper at the stable path and loads its launch agent', async () => {
    const f = fixture({ bundled: '0.2.0' })
    const launchd = fakeLaunchd()

    const outcome = await runPodGoCacheLifecycle(f.input, launchd.run)

    expect(outcome).toMatchObject({ status: 'installed', decision: { reason: 'first-install' } })
    expect(readFileSync(f.installedHelper, 'utf8')).toBe(readFileSync(f.bundledHelper, 'utf8'))
    expect(await helperVersion(f.installedHelper)).toBe('0.2.0')
    expect(existsSync(f.plist)).toBe(true)
    expect(launchd.state.loaded).toBe(true)
    expect(launchd.calls).toContainEqual(['bootstrap', `gui/${UID}`, f.plist])
  })

  it('leaves a current install alone on the next launch', async () => {
    const f = fixture({ bundled: '0.2.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    const installedAt = statSync(f.installedHelper).mtimeMs
    launchd.calls.length = 0

    const outcome = await runPodGoCacheLifecycle(f.input, launchd.run)

    expect(outcome).toMatchObject({ status: 'up-to-date', kickstarted: false })
    expect(statSync(f.installedHelper).mtimeMs).toBe(installedAt)
    expect(launchd.writes()).toEqual([])
  })

  it('upgrades an older install and restarts the daemon on the new binary', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true })

    const outcome = await runPodGoCacheLifecycle(f.input, launchd.run)

    expect(outcome).toMatchObject({
      status: 'installed',
      decision: { reason: 'version-changed', from: '0.2.0', version: '0.3.0' }
    })
    expect(await helperVersion(f.installedHelper)).toBe('0.3.0')
    const verbs = launchd.calls.map(([verb]) => verb)
    expect(verbs.indexOf('bootout')).toBeLessThan(verbs.indexOf('bootstrap'))
    expect(launchd.state).toEqual({ loaded: true, running: true })
  })

  it.each([
    ['an older release over a newer one', { bundled: '0.2.0', installed: '0.3.0' }],
    ['a prerelease over its own release', { bundled: '0.3.0-rc.1', installed: '0.3.0' }],
    ['0.9.0 over 0.10.0 (numbers, not text)', { bundled: '0.9.0', installed: '0.10.0' }]
  ])('never installs %s', async (_name, versions) => {
    const f = fixture(versions)
    const launchd = fakeLaunchd({ loaded: true, running: true })
    const before = readFileSync(f.installedHelper, 'utf8')

    const outcome = await runPodGoCacheLifecycle(f.input, launchd.run)

    expect(outcome).toMatchObject({ status: 'skipped', decision: { reason: 'newer-installed' } })
    expect(readFileSync(f.installedHelper, 'utf8')).toBe(before)
    expect(launchd.writes()).toEqual([])
  })

  it('replaces a dev build of the same release with the bundled one', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.3.0-dev.20261017120000' })
    const launchd = fakeLaunchd({ loaded: true, running: true })

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'version-changed' }
    })
    expect(await helperVersion(f.installedHelper)).toBe('0.3.0')
  })

  it('leaves a same-version build with other bytes alone: each signed build differs', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    // another Pod build (or an older Pod) bundling the same VERSION, signed at another time
    writeHelper(f.bundledHelper, '0.3.0', 'signed later')
    const installed = readFileSync(f.installedHelper, 'utf8')
    launchd.calls.length = 0

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'up-to-date'
    })
    expect(readFileSync(f.installedHelper, 'utf8')).toBe(installed)
    expect(launchd.writes()).toEqual([])
  })

  it('two Pods with other bundle ids and the same helper version never undo each other', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    const plist = readFileSync(f.plist, 'utf8')
    launchd.calls.length = 0
    const other = { ...f.input, bundleId: 'codes.pod.app.rc' }
    writeHelper(f.bundledHelper, '0.3.0', 'the rc build')

    for (const input of [other, f.input, other]) {
      await expect(runPodGoCacheLifecycle(input, launchd.run)).resolves.toMatchObject({
        status: 'up-to-date'
      })
    }
    expect(readFileSync(f.plist, 'utf8')).toBe(plist)
    expect(launchd.writes()).toEqual([])
  })

  it('repairs a half-written install: a leftover temp copy and a binary that answers nothing', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const bin = join(f.home, '.pod/gocache/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, '.pod-gocache.999.pod-gocache.tmp'), 'half a copy')
    writeFileSync(f.installedHelper, '\0\0\0truncated')
    chmodSync(f.installedHelper, 0o755)
    const launchd = fakeLaunchd()

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'installed-broken', from: null }
    })
    expect(await helperVersion(f.installedHelper)).toBe('0.3.0')
    expect(readdirSync(bin)).toEqual(['pod-gocache'])
  })

  it('repairs an installed helper that lost its executable bit', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.3.0' })
    chmodSync(f.installedHelper, 0o644)
    const launchd = fakeLaunchd({ loaded: true, running: true })

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'installed-broken' }
    })
    expect(statSync(f.installedHelper).mode & 0o111).not.toBe(0)
  })

  it('leaves an installed helper that never answers version alone until a launch where it does', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.4.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true })
    // a first exec stuck behind the malware scan
    const run = async (spec: ProcessSpec): Promise<ProcessResult> =>
      spec.program === f.installedHelper
        ? { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }
        : launchd.run(spec)

    await expect(runPodGoCacheLifecycle(f.input, run)).resolves.toEqual({
      status: 'skipped',
      decision: { action: 'skip', reason: 'installed-unanswered' }
    })
    expect(await helperVersion(f.installedHelper)).toBe('0.4.0')
    expect(launchd.writes()).toEqual([])
  })

  it('never puts a copy that does not answer version at the stable path', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true })
    // the copy's exec fails as a full disk or a quarantine would make it fail
    const run = async (spec: ProcessSpec): Promise<ProcessResult> =>
      spec.program.includes('.pod-gocache.') ? result(126, '', 'killed') : launchd.run(spec)

    const outcome = await runPodGoCacheLifecycle(f.input, run)

    expect(outcome).toMatchObject({ status: 'failed', message: expect.stringContaining('0.3.0') })
    expect(await helperVersion(f.installedHelper)).toBe('0.2.0')
    expect(readdirSync(join(f.home, '.pod/gocache/bin'))).toEqual(['pod-gocache'])
    expect(launchd.calls.some(([verb]) => verb === 'bootout')).toBe(false)
  })

  it('never installs twice at once, and takes over a stale lock', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const lock = join(f.home, '.pod/gocache/pod-install.lock')
    mkdirSync(join(lock, '..'), { recursive: true })
    writeFileSync(lock, '999')
    const launchd = fakeLaunchd()

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'busy'
    })
    expect(existsSync(f.installedHelper)).toBe(false)
    const old = (Date.now() - 11 * 60_000) / 1000
    utimesSync(lock, old, old)
    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed'
    })
    expect(existsSync(lock)).toBe(false)
  })

  it('decides again under the lock: a newer helper installed meanwhile is never rolled back', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true })
    let raced = false
    // a newer Pod installs 0.4.0 right after this one read 0.2.0, before it takes the lock
    const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
      const answer = await launchd.run(spec)
      if (!raced && spec.program === f.installedHelper) {
        raced = true
        writeHelper(f.installedHelper, '0.4.0', 'the newer Pod')
      }
      return answer
    }

    await expect(runPodGoCacheLifecycle(f.input, run)).resolves.toMatchObject({
      status: 'skipped',
      decision: { reason: 'newer-installed' }
    })
    expect(await helperVersion(f.installedHelper)).toBe('0.4.0')
    expect(launchd.writes()).toEqual([])
  })

  it.each([
    ['not on macOS', { platform: 'linux' as const }, 'not-darwin'],
    ['a harness launched Pod', { automatedBy: 'ORCA_E2E_HEADLESS' }, 'automated-launch'],
    ['HOME is not the account home', { accountHome: '/Users/the-real-account' }, 'home-override'],
    ['the account home is unknown', { accountHome: null }, 'home-override'],
    ['Pod runs another profile', { userDataPath: '/private/tmp/bench/userData' }, 'custom-profile'],
    ['the build has no default profile', { defaultUserDataPath: null }, 'custom-profile']
  ])('touches nothing in HOME or launchd when %s', async (_name, override, reason) => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()

    const outcome = await runPodGoCacheLifecycle({ ...f.input, ...override }, launchd.run)

    expect(outcome).toEqual({ status: 'skipped', decision: { action: 'skip', reason } })
    expect(readdirSync(f.home)).toEqual([])
    expect(launchd.calls).toEqual([])
  })

  it.each([
    ['a build without the helper', { bundled: null }, 'no-helper'],
    ['a bundled helper that answers nothing', { bundled: 'garbage' }, 'helper-broken']
  ])('installs nothing from %s', async (_name, options, reason) => {
    const f = fixture(options)
    const launchd = fakeLaunchd()

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'skipped',
      decision: { reason }
    })
    expect(readdirSync(f.home)).toEqual([])
    expect(launchd.writes()).toEqual([])
  })

  it.each([
    ['POD_GOCACHE=0', { mode: '0' }, 'disabled'],
    ['POD_GOCACHE=off', { mode: 'off' }, 'disabled'],
    ['the setting', { settingEnabled: false }, 'setting-off']
  ])(
    'turned off by %s, leaves an installed agent running and installs nothing',
    async (_name, override, reason) => {
      const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
      const launchd = fakeLaunchd({ loaded: true, running: true })

      const outcome = await runPodGoCacheLifecycle({ ...f.input, ...override }, launchd.run)

      expect(outcome).toEqual({ status: 'skipped', decision: { action: 'skip', reason } })
      expect(await helperVersion(f.installedHelper)).toBe('0.2.0')
      expect(launchd.calls).toEqual([])
      expect(launchd.state).toEqual({ loaded: true, running: true })
    }
  )

  it('retries a bootstrap launchd refuses while it still tears the old job down', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true, failedBootstraps: 1 })

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed'
    })
    expect(launchd.state.loaded).toBe(true)
  })

  it('backs off a failing install: next launch, then not again for 10 minutes', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const at = Date.parse('2026-10-17T10:00:00Z')
    const broken = fakeLaunchd({ failedBootstraps: 100 })
    const record = (): unknown =>
      JSON.parse(readFileSync(join(f.home, '.pod/gocache/pod-lifecycle.json'), 'utf8'))

    await expect(
      runPodGoCacheLifecycle({ ...f.input, now: at }, broken.run)
    ).resolves.toMatchObject({
      status: 'failed',
      exit: 5,
      message: expect.stringContaining('bootstrap')
    })
    expect(record()).toMatchObject({ status: 'failed', payload: '0.3.0', attempts: 1 })

    await expect(
      runPodGoCacheLifecycle({ ...f.input, now: at + 1000 }, broken.run)
    ).resolves.toMatchObject({ status: 'failed', decision: { failedAttempts: 1 } })
    expect(record()).toMatchObject({ status: 'failed', attempts: 2 })

    broken.calls.length = 0
    await expect(
      runPodGoCacheLifecycle({ ...f.input, now: at + 5 * 60_000 }, broken.run)
    ).resolves.toMatchObject({ status: 'skipped', decision: { reason: 'install-backoff' } })
    expect(broken.writes()).toEqual([])

    const healthy = fakeLaunchd()
    await expect(
      runPodGoCacheLifecycle({ ...f.input, now: at + 11 * 60_000 }, healthy.run)
    ).resolves.toMatchObject({ status: 'installed', decision: { reason: 'agent-missing' } })
    expect(record()).toMatchObject({ status: 'installed', attempts: 0 })
  })

  it('starts a loaded daemon that exited, once per launch, without reinstalling', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    launchd.state.running = false
    launchd.calls.length = 0

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'up-to-date',
      kickstarted: true
    })
    expect(launchd.writes()).toEqual([['kickstart', `gui/${UID}/codes.pod.gocache`]])
  })

  it('dry run decides and reports, and changes nothing', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true })

    await expect(
      runPodGoCacheLifecycle({ ...f.input, mode: 'dry-run' }, launchd.run)
    ).resolves.toMatchObject({ status: 'dry-run', decision: { reason: 'version-changed' } })
    expect(await helperVersion(f.installedHelper)).toBe('0.2.0')
    expect(existsSync(f.plist)).toBe(false)
    expect(existsSync(join(f.home, '.pod/gocache/pod-lifecycle.json'))).toBe(false)
    expect(launchd.writes()).toEqual([])
  })

  it('never touches launchd without a uid to name its domain', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()

    await expect(
      runPodGoCacheLifecycle({ ...f.input, uid: null }, launchd.run)
    ).resolves.toMatchObject({ status: 'refused', message: 'the uid is unknown' })
    expect(existsSync(f.installedHelper)).toBe(false)
    expect(launchd.calls).toEqual([])
  })

  it.each([
    ['a newer helper', { bundled: '0.3.0-dev.20261017120000', installed: '0.4.0' }],
    ['the same version built elsewhere', { bundled: '0.3.0', installed: '0.3.0' }]
  ])('--force replaces %s, still through a checked temp copy', async (_name, versions) => {
    const f = fixture(versions)
    const launchd = fakeLaunchd({ loaded: true, running: true })

    await expect(
      runPodGoCacheLifecycle({ ...f.input, force: true }, launchd.run)
    ).resolves.toMatchObject({ status: 'installed', decision: { reason: 'forced' } })
    expect(readFileSync(f.installedHelper, 'utf8')).toBe(readFileSync(f.bundledHelper, 'utf8'))
    expect(readdirSync(join(f.home, '.pod/gocache/bin'))).toEqual(['pod-gocache'])
  })
})
