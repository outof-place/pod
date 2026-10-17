// Fork-only (Pod): the app module's calls on a device (stage 5's SimAppDevice), made with the
// device driver's own simctl (sim-device-driver.ts), so they reach Pod's set alone, after the set is
// claimed and made, and answer within their timeouts without throwing.
//
// Whether an app is installed or running is read on this Mac when it can be: CoreSimulator keeps a
// device's apps at `<set>/<udid>/data/Containers/Bundle/Application/<UUID>/<name>.app`, and a
// running app is a process of this Mac whose executable lies there. Under load each `simctl spawn`
// or `get_app_container` took 1 to 27 s (stage 5's real test), a folder read and the process table
// take milliseconds. When the folder is not there, simctl answers as before.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SimAppDevice } from '../apps/sim-app-device'
import type { SimOpOutcome } from '../pool/sim-pool-ports'
import type { SimRun, SimRunResult } from './sim-command-run'
import type { SimProcessFacts } from './sim-process-facts'
import { userAppsRunning } from './sim-simctl-output'

// A 93 MB client installs in 0.5 to 0.8 s (stage 0); a 418 MB one in 20 to 70 s under load.
const TIMEOUT_MS = {
  appContainer: 15_000,
  install: 180_000,
  uninstall: 60_000,
  launch: 30_000,
  appsRunning: 15_000,
  plist: 5_000
} as const

// simctl uninstall of an app the device does not have.
const NOT_INSTALLED = /not installed|No such file|could not be found/i
const CONTAINER_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

type Simctl = (args: readonly string[], timeoutMs: number) => Promise<SimRunResult>
// The driver's step: null when the call did what it should, else why not.
type Step = (
  what: string,
  result: Promise<SimRunResult>,
  tolerate?: RegExp
) => Promise<string | null>

/** What lets the ops read a device's apps on this Mac instead of asking simctl. */
export type SimDeviceAppFacts = Readonly<{
  deviceSet: string
  run: SimRun
  // null: `simctl spawn launchctl list` says which apps run.
  processes: SimProcessFacts | null
}>

const outcome = (failure: string | null): SimOpOutcome =>
  failure ? { ok: false, message: failure } : { ok: true }

/** One string of a plist, kept while the file is unchanged. */
function createPlistStrings(run: SimRun) {
  const known = new Map<string, { mtimeMs: number; value: string | null }>()
  return async (plist: string, key: string): Promise<string | null> => {
    const info = await stat(plist).catch(() => null)
    if (!info) {
      return null
    }
    const cached = known.get(`${plist}\u0000${key}`)
    if (cached?.mtimeMs === info.mtimeMs) {
      return cached.value
    }
    const read = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      timeoutMs: TIMEOUT_MS.plist
    })
    const value = read.ok && read.code === 0 ? read.stdout.trim() || null : null
    known.set(`${plist}\u0000${key}`, { mtimeMs: info.mtimeMs, value })
    return value
  }
}

export function simDeviceAppOps(
  simctl: Simctl,
  step: Step,
  facts: SimDeviceAppFacts | null = null
): SimAppDevice {
  const plistString = facts ? createPlistStrings(facts.run) : null
  const bundleIdOf = plistString
    ? (appDir: string) => plistString(join(appDir, 'Info.plist'), 'CFBundleIdentifier')
    : null

  /** The device's installed apps by bundle id; null when its folders cannot be read. */
  const installedOnDisk = async (udid: string): Promise<Set<string> | null> => {
    if (!facts || !bundleIdOf || !CONTAINER_UUID.test(udid)) {
      return null
    }
    const containers = join(facts.deviceSet, udid, 'data', 'Containers')
    if (!(await stat(containers).catch(() => null))?.isDirectory()) {
      return null
    }
    const root = join(containers, 'Bundle', 'Application')
    // A booted device with no app installed yet has no Bundle folder.
    const entries = await readdir(root).catch(() => [])
    const ids = await Promise.all(
      entries
        .filter((entry) => CONTAINER_UUID.test(entry))
        .map(async (entry) => {
          const apps = await readdir(join(root, entry)).catch(() => [])
          const app = apps.find((name) => name.endsWith('.app'))
          return app ? bundleIdOf(join(root, entry, app)) : null
        })
    )
    return new Set(ids.filter((id): id is string => id !== null))
  }

  /** Whether a process of this Mac runs the app from this device; null when it cannot tell. */
  const runningOnDisk = async (udid: string, bundleId: string): Promise<boolean | null> => {
    if (!facts?.processes || !bundleIdOf || !CONTAINER_UUID.test(udid)) {
      return null
    }
    const rows = await facts.processes.table()
    if (!rows) {
      return null
    }
    const appDir = new RegExp(
      `^(/.*/${udid}/data/Containers/Bundle/Application/[0-9A-F-]{36}/[^/]+\\.app)/`
    )
    const dirs = new Set(rows.flatMap((row) => appDir.exec(row.command)?.[1] ?? []))
    for (const dir of dirs) {
      if ((await bundleIdOf(dir)) === bundleId) {
        return true
      }
    }
    return false
  }

  return {
    async appInstalled(udid, bundleId) {
      const onDisk = await installedOnDisk(udid)
      if (onDisk) {
        return onDisk.has(bundleId)
      }
      const result = await simctl(
        ['get_app_container', udid, bundleId, 'app'],
        TIMEOUT_MS.appContainer
      )
      return result.ok ? result.code === 0 : 'unknown'
    },

    async install(udid, appPath) {
      return outcome(
        await step('simctl install', simctl(['install', udid, appPath], TIMEOUT_MS.install))
      )
    },

    async uninstall(udid, bundleId) {
      return outcome(
        await step(
          'simctl uninstall',
          simctl(['uninstall', udid, bundleId], TIMEOUT_MS.uninstall),
          NOT_INSTALLED
        )
      )
    },

    async launch(udid, bundleId, args) {
      return outcome(
        await step(
          'simctl launch',
          simctl(
            ['launch', '--terminate-running-process', udid, bundleId, ...args],
            TIMEOUT_MS.launch
          )
        )
      )
    },

    async appRunning(udid, bundleId) {
      const onDisk = await runningOnDisk(udid, bundleId)
      if (onDisk !== null) {
        return onDisk
      }
      const listed = await simctl(['spawn', udid, 'launchctl', 'list'], TIMEOUT_MS.appsRunning)
      if (!listed.ok || listed.code !== 0) {
        return 'unknown'
      }
      return userAppsRunning(listed.stdout).includes(bundleId)
    },

    async deviceName(udid) {
      // CoreSimulator's own record of the device, as `simctl list` reads it.
      return facts && plistString && CONTAINER_UUID.test(udid)
        ? plistString(join(facts.deviceSet, udid, 'device.plist'), 'name')
        : null
    }
  }
}
