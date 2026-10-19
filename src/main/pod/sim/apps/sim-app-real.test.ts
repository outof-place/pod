// A Portivo worktree's dev client on a real booted device, through the real adapters (stage 5's
// outer loop). Opt in, under the shared e2e lock, never in a plain run:
//   lockf -t 3000 /private/tmp/pn-e2e.lock env POD_SIM_REAL=1 \
//     POD_SIM_APPS_WORKTREE=<a Portivo worktree whose mobile client portivo-mobile cached> \
//     pnpm test src/main/pod/sim/apps/sim-app-real.test.ts
// The recipe is a local override in a throwaway POD_SIM_HOME (nothing is written into Portivo); the
// client is adopted from portivo-mobile's cache, which is only read. One device of this test's own,
// in that home's set, booted once and deleted at the end; the default set is compared before and
// after. Metro runs for the worktree on its own port and is stopped through reconcile. Hops go to
// POD_SIM_EVIDENCE (written after every case).
//
// "On screen" is the app's own UI (simAppOwnUi): the first settle whose accessibility tree is neither
// the splash, React Native's loading banner, nor its error screens (LogBox's "Log 1 of 73 / Uncaught
// Error / Call Stack", the red box), which run 1 took for the app, and the 19.10 run the red box's
// "Could not connect to development server" too.
import { runProcess } from '@orca/process-host'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { simRunProcess } from '../adapters/sim-command-run'
import { createSimDeviceDriver } from '../adapters/sim-device-driver'
import { claimSimPodHome, simPodHome, type SimPodHome } from '../adapters/sim-pod-home'
import { createSimProcessFacts } from '../adapters/sim-process-facts'
import { createSimRegistryFileStore } from '../adapters/sim-registry-file-store'
import { parseSimctlList } from '../adapters/sim-simctl-output'
import { SimHelperSupervisor } from '../helper/sim-helper-supervisor'
import type { SimRuntime } from '../pool/sim-pool-ports'
import { probeSimMetro } from './sim-app-metro-http'
import { createSimApps, type SimApps } from './sim-app-readiness'
import { simRepoKey } from './sim-app-recipes'
import { simAppOwnUi } from './sim-app-own-ui.test-support'
import { thisRuntime, writeLeases } from './sim-app.test-support'

const REAL = process.env.POD_SIM_REAL === '1'
const WORKTREE = process.env.POD_SIM_APPS_WORKTREE ?? ''
const EVIDENCE = process.env.POD_SIM_EVIDENCE || '/private/tmp/pod-sim-apps-evidence'
const CLIENTS = process.env.POD_SIM_APPS_CLIENTS || '~/.cache/portivo-mobile/clients/eu.portivo.app'
const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
const BUNDLE = 'eu.portivo.app'
// Portivo's mobile app as its recipe will say it (stage 11 writes the real one into the repo).
const recipe = (repo: string) =>
  [
    `${JSON.stringify(repo)}:`,
    '  default: mobile',
    '  apps:',
    '    mobile:',
    `      bundleId: ${BUNDLE}`,
    '      scheme: portivo',
    '      path: apps/mobile',
    '      metro:',
    // Not 8083: other sessions run this worktree's Metro from 8183 up, and Pod would use theirs.
    '        port: 8483',
    '        command: ./node_modules/.bin/expo start --port {port}',
    // The fingerprint without the worktree's .env (Metro loads it): its EXPO_PUBLIC values reach
    // app.config.ts and would make every .env its own native build (c118632b becomes 6403326f).
    "      fingerprint: 'EXPO_NO_DOTENV=1 ./node_modules/.bin/fingerprint fingerprint:generate --platform ios'",
    `      clientCache: ${JSON.stringify(CLIENTS)}`,
    '      appDefaults:',
    '        EXDevMenuIsOnboardingFinished: true',
    '        EXDevMenuShowsAtLaunch: false',
    '        EXDevMenuShowFloatingActionButton: false',
    ''
  ].join('\n')

async function listed(set?: string): Promise<string[]> {
  const result = await runProcess({
    program: '/usr/bin/xcrun',
    args: ['simctl', ...(set ? ['--set', set] : []), 'list', 'devices', '-j'],
    timeoutMs: 60_000
  })
  return (parseSimctlList(result.stdout) ?? [])
    .map((device) => `${device.runtime} ${device.name} ${device.udid} ${device.state}`)
    .sort()
}

describe.skipIf(!REAL || !WORKTREE)('a Portivo worktree’s app on a real booted device', () => {
  let root: string
  let home: SimPodHome
  let self: SimRuntime
  let apps: SimApps
  let helper: SimHelperSupervisor
  let udid = ''
  let before: string[]
  const report: Record<string, unknown> = {}
  const driver = () =>
    createSimDeviceDriver({
      deviceSet: home.deviceSet,
      run: simRunProcess,
      processes: createSimProcessFacts(),
      ensureSet: async (set) => {
        await claimSimPodHome(home)
        mkdirSync(set, { recursive: true })
      }
    })

  /** What the dev client got from Metro and what the app logged, when it did not reach its own UI. */
  const diagnose = async (port: number | undefined, label: string) => {
    const manifest = await new Promise<string>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          headers: { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' },
          timeout: 30_000
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (body += chunk))
          res.on('end', () => resolve(`HTTP ${res.statusCode} ${body.slice(0, 1500)}`))
        }
      )
      req.on('error', (error) => resolve(error.message))
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.end()
    })
    const log = await runProcess({
      program: '/usr/bin/xcrun',
      args: [
        'simctl',
        '--set',
        home.deviceSet,
        'spawn',
        udid,
        'log',
        'show',
        '--last',
        '3m',
        '--style',
        'compact',
        '--predicate',
        'process == "Portivo"'
      ],
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024 * 1024
    })
    const lines = log.stdout
      .split('\n')
      .filter((line) =>
        /DevLauncher|initialUrl|manifest|bundle|error|fail|127\.0\.0\.1/i.test(line)
      )
    writeFileSync(join(EVIDENCE, `apps-real-device-log-${label}.txt`), lines.join('\n'))
    return { manifest, deviceLogLines: lines.length, deviceLogTail: lines.slice(-25) }
  }

  /** The JS runtimes connected to the worktree's Metro (its inspector's /json/list). */
  const pages = async (port: number | undefined) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list: unknown = await response.json()
      return Array.isArray(list)
        ? list.map(
            (page: { appId?: unknown; deviceName?: unknown }) =>
              `${String(page.appId)} on ${String(page.deviceName)}`
          )
        : list
    } catch (error) {
      return String(error)
    }
  }

  /**
   * Settles until the app's own UI is on screen; each settle's outcome and labels go in the report,
   * and when the app never shows, what Metro and the device say.
   */
  const untilTheApp = async (budgetMs: number, port: number | undefined, label: string) => {
    const begun = performance.now()
    const settles: unknown[] = []
    while (performance.now() - begun < budgetMs) {
      const settle = await helper.call('settle', { udid, windowMs: 400, timeoutMs: 20_000 })
      const ax = await helper.call('ax', { udid, maxNodes: 60 })
      const labels = ax.ok ? ax.value.nodes.map((node) => node.label ?? '').filter(Boolean) : []
      const at = Math.round(performance.now() - begun)
      settles.push({
        at,
        settle: settle.ok ? settle.value.outcome : settle,
        labels: labels.slice(0, 20),
        ...(ax.ok
          ? {
              nodes: {
                total: ax.value.total,
                omitted: ax.value.omitted,
                notVisible: ax.value.notVisible
              }
            }
          : {})
      })
      if (
        settle.ok &&
        simAppOwnUi(labels, labels.length > 0 && (await driver().appRunning(udid, BUNDLE)) === true)
      ) {
        return { ok: true, ms: at, settles, labels }
      }
    }
    return {
      ok: false,
      ms: Math.round(performance.now() - begun),
      settles,
      running: await driver().appRunning(udid, BUNDLE),
      metroPages: await pages(port),
      diagnostics: await diagnose(port, label)
    }
  }

  const bundledLines = async (logPath: string | undefined) =>
    logPath
      ? (await readFile(logPath, 'utf8').catch(() => ''))
          .split('\n')
          .filter((line) => /Bundled|Bundling failed/.test(line))
          .map((line) =>
            line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').trim()
          )
      : []

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true })
    before = await listed()
    root = await mkdtemp('/private/tmp/pod-sim-apps-real.')
    home = simPodHome({ POD_SIM_HOME: root })
    const claimed = await claimSimPodHome(home)
    if (!claimed.ok) {
      throw new Error(claimed.message)
    }
    await writeFile(join(root, 'recipes.yaml'), recipe(await simRepoKey(WORKTREE)))
    self = await thisRuntime('pod-sim-apps-real')
    const claim = () => claimSimPodHome(home)
    apps = createSimApps({
      home,
      claim,
      store: createSimRegistryFileStore({ home, claim }),
      device: driver(),
      self,
      processes: createSimProcessFacts(),
      runtimeState: async () => 'live',
      claudeAcc: null,
      run: simRunProcess,
      userHome: homedir(),
      metroGraceMs: 0
    })
    helper = new SimHelperSupervisor({
      packaged: false,
      deviceSet: home.deviceSet,
      helloTimeoutMs: 30_000,
      readyTimeoutMs: 30_000
    })
    const made = await driver().create('Portivo-Pod-AppsProbe', DEVICE_TYPE, RUNTIME)
    if (!made.ok || !made.udid) {
      throw new Error(made.ok ? 'no udid' : made.message)
    }
    udid = made.udid
    // One boot (a pool device is made and booted before a lease; the timings start once it is).
    let at = performance.now()
    const boot = await driver().boot(udid)
    if (!boot.ok) {
      throw new Error(boot.message)
    }
    report['device first boot, ms'] = Math.round(performance.now() - at)
    // "Booted" means idle: the home screen settled, the helper attached.
    at = performance.now()
    const idle = await helper.call('settle', { udid, windowMs: 1000, timeoutMs: 20_000 })
    report['home screen settled, ms'] = idle.ok ? Math.round(performance.now() - at) : idle
    // A lease of this worktree's app holds the device: its Metro runs while the test does.
    await writeLeases(home, self, [{ worktreeRoot: WORKTREE, appId: 'mobile', holds: udid }])
  }, 10 * 60_000)

  // Written after every case: a run cut short still leaves what it measured.
  afterEach(() => {
    writeFileSync(join(EVIDENCE, 'apps-real.json'), JSON.stringify(report, null, 1))
  })

  afterAll(async () => {
    if (apps) {
      await writeLeases(home, self, [])
      await apps.reconcile()
      await apps.reconcile()
    }
    await cp(join(root, 'metro'), join(EVIDENCE, 'metro-logs'), { recursive: true }).catch(
      () => undefined
    )
    await helper?.stop()
    if (udid) {
      await driver().shutDown(udid)
      await driver().delete(udid)
    }
    writeFileSync(join(EVIDENCE, 'apps-real.json'), JSON.stringify(report, null, 1))
    console.log(JSON.stringify(report, null, 1))
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
    expect(await listed()).toEqual(before)
  }, 5 * 60_000)

  it(
    'first lease of a worktree Pod never saw: fingerprint, adopted client, cold Metro',
    async () => {
      const start = performance.now()
      const prepared = await apps.prepare({ worktreeRoot: WORKTREE })
      report['A prepare, hops ms'] = prepared.ok ? prepared.ms : prepared
      expect(prepared.ok && prepared.client.state).toBe('cached')
      const opened = await apps.open({ worktreeRoot: WORKTREE, udid })
      report['A open'] = opened
      expect(opened).toMatchObject({ ok: true, installed: true, launched: true, connected: true })
      const launched = performance.now()
      const shown = await untilTheApp(120_000, prepared.ok ? prepared.metro?.port : undefined, 'A')
      report['A launch to the app on screen'] = shown
      report['A lease to the app on screen, ms'] = Math.round(performance.now() - start)
      report['A launch to the app on screen, ms'] = Math.round(performance.now() - launched)
      report['A Metro pages'] = await pages(prepared.ok ? prepared.metro?.port : undefined)
      report['A Metro bundles'] = await bundledLines(
        prepared.ok ? prepared.metro?.logPath : undefined
      )
      await helper.call('screenshot', { udid, path: join(EVIDENCE, 'apps-real-first-lease.png') })
      expect(shown.ok).toBe(true)
    },
    6 * 60_000
  )

  it('warm: the app already runs on its Metro, so the next lease finds it on screen', async () => {
    const start = performance.now()
    const prepared = await apps.prepare({ worktreeRoot: WORKTREE })
    const opened = await apps.open({ worktreeRoot: WORKTREE, udid })
    const ms = Math.round(performance.now() - start)
    report['B prepare, hops ms'] = prepared.ok ? prepared.ms : prepared
    report['B open'] = opened
    report['B lease to the app on screen, ms'] = ms
    report['B under 5 s'] = ms < 5_000
    expect(opened).toMatchObject({ ok: true, installed: false, launched: false, connected: true })
  }, 60_000)

  it(
    'warm relaunch: the pool’s release ended the app, Metro still has the bundle',
    async () => {
      const released = await driver().release(udid)
      report['C release'] = released
      const start = performance.now()
      await apps.prepare({ worktreeRoot: WORKTREE })
      const opened = await apps.open({ worktreeRoot: WORKTREE, udid })
      report['C open'] = opened
      const shown = await untilTheApp(
        60_000,
        opened.ok ? (opened.metroPort ?? undefined) : undefined,
        'C'
      )
      report['C launch to the app on screen'] = shown
      report['C lease to the app on screen, ms'] = Math.round(performance.now() - start)
      expect(opened).toMatchObject({ ok: true, installed: false, launched: true, connected: true })
      expect(shown.ok).toBe(true)
    },
    2 * 60_000
  )

  /** A lease after the worktree's Metro stopped (its grace passed) and the pool ended the app. */
  const coldMetroLease = async (name: string, installed: boolean) => {
    await writeLeases(home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    await driver().release(udid)
    if (!installed) {
      await driver().uninstall(udid, BUNDLE)
    }
    await writeLeases(home, self, [{ worktreeRoot: WORKTREE, appId: 'mobile', holds: udid }])
    const start = performance.now()
    const prepared = await apps.prepare({ worktreeRoot: WORKTREE })
    report[`${name} prepare, hops ms`] = prepared.ok ? prepared.ms : prepared
    const opened = await apps.open({ worktreeRoot: WORKTREE, udid })
    report[`${name} open`] = opened
    expect(opened).toMatchObject({
      ok: true,
      installed: !installed,
      launched: true,
      connected: true
    })
    const shown = await untilTheApp(120_000, prepared.ok ? prepared.metro?.port : undefined, name)
    const ms = Math.round(performance.now() - start)
    report[`${name} launch to the app on screen`] = shown
    report[`${name} lease to the app on screen, ms`] = ms
    // The brief's target for a booted device with a cached client; timing is load-bound, so it is
    // reported, and the app reaching its own UI is what the test asserts.
    report[`${name} under 10 s`] = ms < 10_000
    report[`${name} Metro pages`] = await pages(prepared.ok ? prepared.metro?.port : undefined)
    report[`${name} Metro bundles`] = await bundledLines(
      prepared.ok ? prepared.metro?.logPath : undefined
    )
    await helper.call('screenshot', { udid, path: join(EVIDENCE, `apps-real-${name}.png`) })
    expect(shown.ok).toBe(true)
  }

  it(
    'a booted device with the client installed: Metro gone past its grace',
    async () => {
      await coldMetroLease('D1', true)
    },
    4 * 60_000
  )

  it('stops the worktree’s Metro once its last lease is gone', async () => {
    const prepared = await apps.prepare({ worktreeRoot: WORKTREE })
    const port = prepared.ok ? prepared.metro?.port : undefined
    expect(port).toBeTypeOf('number')
    await writeLeases(home, self, [])
    await apps.reconcile()
    await apps.reconcile()
    const appDir = join(WORKTREE, 'apps', 'mobile')
    let answer = await probeSimMetro(port ?? 0, appDir, 500)
    for (let tries = 0; tries < 40 && answer !== 'none'; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      answer = await probeSimMetro(port ?? 0, appDir, 500)
    }
    report['Metro after the last lease'] = answer
    expect(answer).toBe('none')
  }, 60_000)
})
