import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { runPodGoCacheLifecycle } from './pod-gocache-lifecycle'
import {
  LABEL,
  UID,
  fakeLaunchd,
  lifecycleFixture as fixture,
  removeLifecycleFixtures,
  writeGo
} from './pod-gocache-lifecycle-fixture'

// The launch agent's side of the lifecycle: the user's go and GOCACHE, the plist, and launchctl.

afterEach(removeLifecycleFixtures)

describe('pod-gocache launch agent', () => {
  it.runIf(process.platform === 'darwin')(
    'writes a plist launchd can parse: the stable helper as a daemon on the user GOCACHE',
    async () => {
      const f = fixture({ bundled: '0.3.0' })
      // a home with characters XML must escape
      const odd = `${f.home}/a&b <c>`
      mkdirSync(odd)
      const profile = join(odd, 'Library/Application Support/Pod')
      const cacheDir = join(odd, 'Library/Caches/go-build')
      writeGo(f.goBin, { gocache: cacheDir })
      await runPodGoCacheLifecycle(
        {
          ...f.input,
          home: odd,
          accountHome: odd,
          userDataPath: profile,
          defaultUserDataPath: profile
        },
        fakeLaunchd().run
      )
      const plist = join(odd, 'Library/LaunchAgents', `${LABEL}.plist`)

      expect((await runProcess({ program: '/usr/bin/plutil', args: ['-lint', plist] })).code).toBe(
        0
      )
      const parsed: unknown = JSON.parse(
        (
          await runProcess({
            program: '/usr/bin/plutil',
            args: ['-convert', 'json', '-o', '-', plist]
          })
        ).stdout
      )
      expect(parsed).toEqual({
        Label: LABEL,
        ProgramArguments: [
          join(odd, '.pod/gocache/bin/pod-gocache'),
          'daemon',
          '--cache-dir',
          cacheDir
        ],
        AssociatedBundleIdentifiers: ['codes.pod.app'],
        WorkingDirectory: join(odd, '.pod/gocache'),
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        ThrottleInterval: 30,
        ProcessType: 'Standard',
        ExitTimeOut: 10,
        StandardOutPath: '/dev/null',
        StandardErrorPath: join(odd, '.pod/gocache/daemon.log')
      })
    }
  )

  it('restarts the daemon once on a changed GOCACHE, then leaves it alone', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    const moved = join(f.root, 'elsewhere/go-build')
    writeGo(f.goBin, { gocache: moved })
    launchd.calls.length = 0

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'agent-changed', cacheDir: moved, replaceHelper: false }
    })
    expect(readFileSync(f.plist, 'utf8')).toContain(`<string>${moved}</string>`)
    expect(launchd.writes().map(([verb]) => verb)).toEqual(['bootout', 'bootstrap'])

    launchd.calls.length = 0
    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'up-to-date'
    })
    expect(launchd.writes()).toEqual([])
  })

  it('reloads an agent that was booted out', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    launchd.state.loaded = false

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'agent-missing' }
    })
    expect(launchd.state.loaded).toBe(true)
  })

  it('waits out the daemon exit on bootout, and goes on when launchd answers "in progress"', async () => {
    const f = fixture({ bundled: '0.3.0', installed: '0.2.0' })
    const launchd = fakeLaunchd({ loaded: true, running: true, bootoutCode: 36 })

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed'
    })
    const bootout = launchd.specs.find((spec) => spec.args?.[0] === 'bootout')
    // longer than the plist's ExitTimeOut (10 s), which bootout may wait out in full
    expect(bootout?.timeoutMs).toBeGreaterThanOrEqual(20_000)
    expect(launchd.state.loaded).toBe(true)
  })

  it('respects an agent the user disabled: no install, no retries, no record', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd({ disabled: true })

    for (let launch = 0; launch < 2; launch++) {
      await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toEqual({
        status: 'skipped',
        decision: { action: 'skip', reason: 'user-disabled' }
      })
    }
    expect(launchd.writes()).toEqual([])
    expect(readdirSync(f.home)).toEqual([])
  })

  it('installs an agent listed as enabled', async () => {
    const f = fixture({ bundled: '0.3.0' })

    await expect(
      runPodGoCacheLifecycle(f.input, fakeLaunchd({ disabled: false }).run)
    ).resolves.toMatchObject({ status: 'installed' })
  })

  it.each([
    ['no go on the login shell PATH', null, 'no-go-toolchain'],
    ['a go that fails', { gocache: '', code: 1 }, 'no-go-toolchain'],
    ['GOCACHE=off', { gocache: 'off' }, 'gocache-off'],
    ['an empty GOCACHE', { gocache: '' }, 'gocache-off']
  ])(
    'skips without a usable go (%s) and installs at the next launch that has one',
    async (_name, answer, reason) => {
      const f = fixture({ bundled: '0.3.0' })
      const launchd = fakeLaunchd()
      if (answer) {
        writeGo(f.goBin, answer)
      }
      const goEnv = answer ? f.input.goEnv : { PATH: join(f.root, 'empty') }

      await expect(runPodGoCacheLifecycle({ ...f.input, goEnv }, launchd.run)).resolves.toEqual({
        status: 'skipped',
        decision: { action: 'skip', reason }
      })
      expect(launchd.writes()).toEqual([])
      expect(existsSync(join(f.home, '.pod/gocache/pod-lifecycle.json'))).toBe(false)

      writeGo(f.goBin, { gocache: f.cacheDir })
      await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
        status: 'installed',
        decision: { cacheDir: f.cacheDir }
      })
    }
  )

  it("never lets the user's GOTOOLCHAIN download a go just to read GOCACHE", async () => {
    const f = fixture({ bundled: '0.3.0' })

    await expect(
      runPodGoCacheLifecycle(
        { ...f.input, goEnv: { ...f.input.goEnv, GOTOOLCHAIN: 'go1.99.0' } },
        fakeLaunchd().run
      )
    ).resolves.toMatchObject({ status: 'installed' })
  })

  it('reads ProgramArguments only from a plist it wrote, rewriting any other', async () => {
    const f = fixture({ bundled: '0.3.0' })
    const launchd = fakeLaunchd()
    await runPodGoCacheLifecycle(f.input, launchd.run)
    writeFileSync(f.plist, '<?xml version="1.0"?><plist version="1.0"><dict/></plist>')

    await expect(runPodGoCacheLifecycle(f.input, launchd.run)).resolves.toMatchObject({
      status: 'installed',
      decision: { reason: 'agent-changed' }
    })
    expect(readFileSync(f.plist, 'utf8')).toContain('<string>--cache-dir</string>')
    expect(launchd.calls).toContainEqual(['bootstrap', `gui/${UID}`, f.plist])
  })
})
