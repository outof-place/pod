/**
 * Fork-only (Pod): opt-in check of a locally packaged Pod.app (POD_PACKAGED_APP=<path>/Pod.app).
 * The dev fixture launches out/main, which reads the identity from an E2E override; this proves
 * the packaged identity file brands the native chrome and keeps Chromium off Stably's hosts.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
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
  runningBundleProcesses,
  wideListeners
} from './helpers/packaged-listener-census'
import {
  runningSecurityAgentPids,
  startSecurityAgentWatchdog
} from './helpers/security-agent-watchdog'

const packagedApp = process.env.POD_PACKAGED_APP ?? ''
const STABLY_HOST = /(^|[./"@])(onorca\.dev|orca\.dev|posthog\.com)\b/i
const STABLY_HOST_RULES = ['onorca.dev', '*.onorca.dev', 'orca.dev', '*.orca.dev', '*.posthog.com']
  .map((host) => `MAP ${host} ~NOTFOUND`)
  .join(', ')

/** Same keychain switches as the dev fixture: an isolated HOME has no login keychain to prompt for. */
function packagedLaunchArgs(netLogPath: string): string[] {
  const args = [
    ...getElectronIsolatedKeychainArgs(),
    '-ApplePersistenceIgnoreState',
    'YES',
    `--log-net-log=${netLogPath}`,
    `--host-resolver-rules=${STABLY_HOST_RULES}`
  ]
  if (process.platform === 'darwin' && !args.includes('--use-mock-keychain')) {
    throw new Error('Refusing to launch a packaged app that could reach the real keychain')
  }
  return args
}

type NativeChrome = { isPackaged: boolean; name: string; titles: string[]; labels: string[] }

/** mtime of every file in the developer's real ~/Library/LaunchAgents, which a run must not touch. */
function realLaunchAgentMtimes(realHome: string): Record<string, number> {
  const dir = path.join(realHome, 'Library', 'LaunchAgents')
  if (!existsSync(dir)) {
    return {}
  }
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, statSync(path.join(dir, name)).mtimeMs])
  )
}

test('a packaged Pod names itself Pod in its window and menus', async () => {
  test.skip(process.platform !== 'darwin' || !packagedApp, 'set POD_PACKAGED_APP to a Pod.app')
  test.setTimeout(240_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'pod-packaged-'))
  const userDataDir = path.join(root, 'userData')
  const netLogPath = path.join(root, 'netlog.json')
  const { ELECTRON_RUN_AS_NODE: _unused, ...inheritedEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: { NODE_ENV: 'production' },
    // Why POD_ACC_LIFECYCLE=off: the bundled claude-acc setup.sh runs launchctl against the real
    // gui/<uid> domain whatever HOME is, so it could replace the developer's own agents.
    extraEnv: { ORCA_BACKGROUND_LAUNCH: '1', POD_ACC_LIFECYCLE: 'off' },
    userDataDir
  })
  if (isolation.env.POD_ACC_LIFECYCLE !== 'off') {
    throw new Error('Refusing to launch a packaged app whose claude-acc lifecycle is on')
  }
  const launchAgentsBefore = realLaunchAgentMtimes(isolation.realHome)
  const args = packagedLaunchArgs(netLogPath)
  const baseline = runningSecurityAgentPids()
  if (baseline.length > 0) {
    throw new Error('SecurityAgent is already running, so a new keychain prompt would go unseen')
  }
  // Why: the listener census counts every process running from the bundle, so none may predate the run.
  const strays = runningBundleProcesses(packagedApp)
  if (strays.length > 0) {
    throw new Error(`Quit the processes already running from the bundle:\n${strays.join('\n')}`)
  }
  const watchdog = startSecurityAgentWatchdog(packagedApp, baseline)
  let app: ElectronApplication | null = null
  let failure: unknown = null
  try {
    app = await electron.launch({
      executablePath: path.join(packagedApp, 'Contents', 'MacOS', 'Pod'),
      args,
      env: { ...isolation.env, ORCA_E2E_HEADLESS: '1' }
    })
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      isolation
    )
    const page = await app.firstWindow()
    await expect
      .poll(async () => page.evaluate(() => document.querySelector('#root')?.childElementCount), {
        timeout: 120_000
      })
      .toBeGreaterThan(0)

    const chrome = await app.evaluate(({ app: electronApp, BrowserWindow, Menu }): NativeChrome => {
      const labels: string[] = []
      const walk = (menu: Electron.Menu | null | undefined): void => {
        for (const item of menu?.items ?? []) {
          // Hidden items (the Stably mobile toggle) never reach the user.
          if (item.visible) {
            labels.push(item.label)
            walk(item.submenu)
          }
        }
      }
      walk(Menu.getApplicationMenu())
      return {
        isPackaged: electronApp.isPackaged,
        name: electronApp.getName(),
        titles: BrowserWindow.getAllWindows().map((window) => window.getTitle()),
        labels
      }
    })
    expect(chrome.isPackaged).toBe(true)
    expect(chrome.name).toBe('Pod')
    expect(chrome.titles).toContain('Pod')
    expect(chrome.titles.filter((title) => /\bOrca\b/.test(title))).toEqual([])
    expect(await page.title()).toBe('Pod')
    expect(chrome.labels).toEqual(expect.arrayContaining(['About Pod', 'Quit Pod']))
    // Why "if present": the slim Pod profile cuts the tour and setup-guide items (pod/slim).
    const promoLabels = chrome.labels.filter((label) =>
      /^(Explore|Getting Started with) /.test(label)
    )
    expect(promoLabels.filter((label) => !/\bPod\b/.test(label))).toEqual([])
    expect(chrome.labels.filter((label) => /\bOrca\b/.test(label))).toEqual([])
    // The slim profile cuts the runtime WebSocket: nothing may listen beyond loopback (*:6768).
    const pid = await app.evaluate(() => process.pid)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    const census = listenerCensus(pid, packagedApp)
    console.log(`[pod-packaged] listener census:\n${formatListenerCensus(census)}`)
    expect(wideListeners(census)).toEqual([])
  } catch (error) {
    failure = error
  } finally {
    watchdog.stop()
    if (app && !watchdog.tripped()) {
      await closeElectronAppForE2E(app)
    }
    await cleanupE2EDaemons(userDataDir)
  }
  // Why first: a keychain prompt is the failure that matters, whatever it broke on the way.
  if (watchdog.tripped()) {
    throw new Error('keychain prompt: SecurityAgent started during the run; the app was killed')
  }
  expect(realLaunchAgentMtimes(isolation.realHome)).toEqual(launchAgentsBefore)
  if (failure !== null) {
    throw failure
  }
  // Why only events: the netlog's constants echo the command line, which names the blocked hosts.
  const netLog = existsSync(netLogPath) ? readFileSync(netLogPath, 'utf8') : ''
  expect(netLog.length).toBeGreaterThan(0)
  const parsed: unknown = JSON.parse(netLog)
  const events =
    typeof parsed === 'object' && parsed !== null && 'events' in parsed
      ? JSON.stringify(parsed.events)
      : ''
  expect(events.length).toBeGreaterThan(0)
  expect(STABLY_HOST.test(events)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})
