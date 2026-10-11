/**
 * Fork-only (Pod): opt-in listener census of a packaged Pod.app (POD_PACKAGED_APP=<path>/Pod.app)
 * in the launches pod-packaged-branding.spec.ts doesn't make: the one-app runtime PodNative starts
 * (--pod-ui-host) and the headless runtime (--serve). Nothing may listen beyond loopback, TCP or UDP.
 * A one-app bundle runs its nested runtime (Contents/Helpers/Pod Runtime.app).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { getElectronIsolatedKeychainArgs } from './helpers/electron-launch-args'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  formatListenerCensus,
  listenerCensus,
  packagedRuntimeExecutable,
  runningBundleProcesses,
  wideListeners
} from './helpers/packaged-listener-census'
import { backupPreferences, restorePreferences } from './helpers/packaged-preferences-guard'
import {
  runningSecurityAgentPids,
  startSecurityAgentWatchdog
} from './helpers/security-agent-watchdog'

const packagedApp = process.env.POD_PACKAGED_APP ?? ''

const LAUNCHES = [
  { name: 'the one-app runtime (--pod-ui-host)', args: ['--pod-ui-host'] },
  { name: 'the headless runtime (--serve --no-pairing)', args: ['--serve', '--no-pairing'] }
]

function entryMtimes(dir: string): Record<string, number> {
  return existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir).map((name) => [name, statSync(path.join(dir, name)).mtimeMs])
      )
    : {}
}

// The real places a packaged run could write outside its profile: agents and serve's CLI link.
function systemEntryMtimes(realHome: string): Record<string, Record<string, number>> {
  const dirs = [
    path.join(realHome, 'Library', 'LaunchAgents'),
    path.join(realHome, '.local', 'bin'),
    '/usr/local/bin'
  ]
  return Object.fromEntries(dirs.map((dir) => [dir, entryMtimes(dir)]))
}

for (const launch of LAUNCHES) {
  test(`a packaged Pod listens only on loopback as ${launch.name}`, async () => {
    test.skip(process.platform !== 'darwin' || !packagedApp, 'set POD_PACKAGED_APP to a Pod.app')
    test.setTimeout(240_000)
    // Why /tmp: under os.tmpdir() the RPC and ui-host socket paths pass the 104-byte sun_path limit.
    const root = mkdtempSync(path.join('/tmp', 'pod-listeners-'))
    const userDataDir = path.join(root, 'userData')
    const { ELECTRON_RUN_AS_NODE: _unused, ...inheritedEnv } = process.env
    void _unused
    const isolation = createElectronHomeIsolation({
      inheritedEnv,
      launchEnv: { NODE_ENV: 'production' },
      // Why: the bundled claude-acc setup.sh runs launchctl against the real gui/<uid> domain.
      // Why the CLI path: before pod/identity a9534ba7c8, serve installed `podx` into /usr/local/bin,
      // which this account can write.
      extraEnv: {
        ORCA_BACKGROUND_LAUNCH: '1',
        POD_ACC_LIFECYCLE: 'off',
        ORCA_CLI_INSTALL_PATH: path.join(root, 'bin', 'podx')
      },
      userDataDir
    })
    const args = [...getElectronIsolatedKeychainArgs(), '-ApplePersistenceIgnoreState', 'YES']
    if (
      !args.includes('--use-mock-keychain') ||
      isolation.env.POD_ACC_LIFECYCLE !== 'off' ||
      !isolation.env.ORCA_CLI_INSTALL_PATH?.startsWith(root)
    ) {
      throw new Error(
        'Refusing to launch a packaged app that could reach the real keychain, agents or CLI link'
      )
    }
    const systemEntriesBefore = systemEntryMtimes(isolation.realHome)
    const baseline = runningSecurityAgentPids()
    if (baseline.length > 0) {
      throw new Error('SecurityAgent is already running, so a new keychain prompt would go unseen')
    }
    const strays = runningBundleProcesses(packagedApp)
    if (strays.length > 0) {
      throw new Error(`Quit the processes already running from the bundle:\n${strays.join('\n')}`)
    }
    const preferences = backupPreferences()
    const watchdog = startSecurityAgentWatchdog(packagedApp, baseline)
    let app: ElectronApplication | null = null
    let failure: unknown = null
    let output = ''
    try {
      app = await electron.launch({
        executablePath: packagedRuntimeExecutable(packagedApp),
        args: [...args, ...launch.args],
        env: { ...isolation.env, ORCA_E2E_HEADLESS: '1' }
      })
      for (const stream of [app.process().stdout, app.process().stderr]) {
        stream?.on('data', (chunk: Buffer) => {
          output = `${output}${chunk.toString()}`.slice(-8_000)
        })
      }
      assertElectronResolvedIsolatedHome(
        await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
        isolation
      )
      // Why this file: neither launch shows a window, and the runtime publishes it once it serves.
      await expect
        .poll(() => existsSync(path.join(userDataDir, 'orca-runtime.json')), { timeout: 120_000 })
        .toBe(true)
      const pid = await app.evaluate(() => process.pid)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const census = listenerCensus(pid, packagedApp)
      console.log(`[pod-packaged] ${launch.name} listener census:\n${formatListenerCensus(census)}`)
      expect(wideListeners(census)).toEqual([])
    } catch (error) {
      failure = error
      console.log(`[pod-packaged] ${launch.name} output tail:\n${output}`)
    } finally {
      watchdog.stop()
      if (app && !watchdog.tripped()) {
        await closeElectronAppForE2E(app)
      }
      await cleanupE2EDaemons(userDataDir)
    }
    const preferenceProblems = restorePreferences(preferences)
    if (watchdog.tripped()) {
      throw new Error('keychain prompt: SecurityAgent started during the run; the app was killed')
    }
    expect(preferenceProblems).toEqual([])
    expect(systemEntryMtimes(isolation.realHome)).toEqual(systemEntriesBefore)
    const seal = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', packagedApp], {
      encoding: 'utf8'
    })
    expect(seal.status, `${seal.stdout}${seal.stderr}`).toBe(0)
    if (failure !== null) {
      throw failure
    }
    rmSync(root, { recursive: true, force: true })
  })
}
