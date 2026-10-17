// Fork-only (Pod): the lease's dev client on its device. Every device call goes through the pool's
// device driver (simctl in Pod's own set, sim-device-driver.ts). `installed/<udid>.json` remembers
// which client fingerprint Pod installed on a device and which Metro it last launched it on, so a
// warm lease skips the install, and a lease that finds its own app already running on its own Metro
// skips the relaunch too (stage 0: a relaunch is an 8 to 10 s JS reload).
//
// Launch is expo-dev-launcher's `--initialUrl` (58.0.11, EXDevLauncherController.m:242 reads it from
// the process arguments and loads that bundle at once; on a simulator it needs no network grant),
// after `--terminate-running-process`: a scheme deep link stops at iOS's "Open in app?" alert.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { SimOpOutcome } from '../pool/sim-pool-ports'
import type { SimAppHome } from './sim-app-paths'

/** What the app module asks of a device; the pool's simctl driver answers. Nothing throws. */
export type SimAppDevice = {
  // 'unknown': simctl did not answer.
  appInstalled(udid: string, bundleId: string): Promise<boolean | 'unknown'>
  install(udid: string, appPath: string): Promise<SimOpOutcome>
  uninstall(udid: string, bundleId: string): Promise<SimOpOutcome>
  launch(udid: string, bundleId: string, args: readonly string[]): Promise<SimOpOutcome>
  appRunning(udid: string, bundleId: string): Promise<boolean | 'unknown'>
  // The name the app reports to Metro's inspector (`deviceName`); null when it cannot be read.
  deviceName(udid: string): Promise<string | null>
}

const Installed = z.looseObject({
  apps: z.record(
    z.string(),
    z.looseObject({
      fingerprint: z.string(),
      installedAt: z.number(),
      launched: z
        .looseObject({ worktreeRoot: z.string(), port: z.number().int(), at: z.number() })
        .optional()
    })
  )
})
type Installed = z.infer<typeof Installed>

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

export type SimInstalledRecords = {
  get(udid: string, bundleId: string): Promise<Installed['apps'][string] | null>
  set(udid: string, bundleId: string, entry: Installed['apps'][string] | null): Promise<void>
  forget(udid: string): Promise<void>
}

/** One small file per device: only its lease's runtime installs on it, one call at a time. */
export function createSimInstalledRecords(home: SimAppHome): SimInstalledRecords {
  const pathOf = (udid: string) => (UDID.test(udid) ? join(home.installed, `${udid}.json`) : null)
  const read = async (udid: string): Promise<Installed> => {
    const path = pathOf(udid)
    try {
      const parsed = Installed.safeParse(JSON.parse(await readFile(path ?? '', 'utf8')))
      return parsed.success ? parsed.data : { apps: {} }
    } catch {
      return { apps: {} }
    }
  }
  return {
    async get(udid, bundleId) {
      return (await read(udid)).apps[bundleId] ?? null
    },
    async set(udid, bundleId, entry) {
      const path = pathOf(udid)
      if (!path) {
        return
      }
      const records = await read(udid)
      if (entry) {
        records.apps[bundleId] = entry
      } else {
        delete records.apps[bundleId]
      }
      await mkdir(home.installed, { recursive: true, mode: 0o700 })
      await writeFile(path, JSON.stringify(records), { mode: 0o600 })
    },
    async forget(udid) {
      const path = pathOf(udid)
      if (path) {
        await rm(path, { force: true })
      }
    }
  }
}
