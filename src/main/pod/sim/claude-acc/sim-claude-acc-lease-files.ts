// Fork-only (Pod): claude-acc's lease file for each Pod device, `<simulator_leases>/<UDID>.json`,
// in the shape portivo-mobile writes and claude-acc's guard reads (devguard_core.py read_lease,
// lease_alive, Simulator.summary): `owner.pid` plus `owner.start` as `ps -o lstart=` prints it (the
// guard checks the pid still runs with that start, within 2 s), `owner.session` for its
// `lease_session`, `app` for its `lease_app`. `holder` and `by` are Pod's own additions. Each file
// is written whole and renamed into place, so the guard never reads half of one; no lease.lock is
// taken (portivo-mobile holds it across whole simctl calls, and only Pod writes Pod's UDIDs).
// A failed write leaves the guard without that holder until the next change; it never throws.
//
// The lease directory itself may be made, never its parent: claude-acc reads an existing
// `~/.cache/portivo-mobile` as portivo-mobile being installed (devguard_core.py portivo_lock), so
// without it the guard goes without Pod's files until 4c teaches it Pod's set. Nothing is written
// off macOS.
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SimLeaseFile, SimLeaseFilePort } from '../pool/sim-pool-ports'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number) => String(n).padStart(2, '0')

/** A start in epoch seconds as macOS `ps -o lstart=` prints it, in local time (`Wed Oct  7 ...`). */
export function psLstartOf(startedAt: number): string {
  const at = new Date(startedAt * 1000)
  const day = String(at.getDate()).padStart(2, ' ')
  const time = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
  return `${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${day} ${time} ${at.getFullYear()}`
}

export type ClaudeAccLeaseFilesOptions = Readonly<{
  directory: string
  platform?: NodeJS.Platform
  onError?: (udid: string, error: unknown) => void
}>

const TEMP_FILE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.json\.\d+\.tmp$/
/** A write takes milliseconds; a temp file this old is one a crash left. */
const STALE_TEMP_MS = 60_000

async function pruneTemps(directory: string): Promise<void> {
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!TEMP_FILE.test(entry)) {
      continue
    }
    const path = join(directory, entry)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > STALE_TEMP_MS) {
      await rm(path, { force: true }).catch(() => undefined)
    }
  }
}

export function createClaudeAccLeaseFiles(options: ClaudeAccLeaseFilesOptions): SimLeaseFilePort {
  const pathOf = (udid: string) => join(options.directory, `${udid}.json`)
  const macOS = (options.platform ?? process.platform) === 'darwin'
  let pruned = false
  return {
    async write(udid: string, file: SimLeaseFile): Promise<void> {
      if (!macOS) {
        return
      }
      const body = {
        owner: {
          pid: file.owner.pid,
          start: psLstartOf(file.owner.startedAt),
          ...(file.session ? { session: file.session } : {})
        },
        ...(file.app ? { app: file.app } : {}),
        holder: file.holder,
        by: 'pod',
        since: new Date().toISOString()
      }
      const temp = `${pathOf(udid)}.${process.pid}.tmp`
      try {
        await mkdir(options.directory).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
            throw error
          }
        })
        if (!pruned) {
          pruned = true
          await pruneTemps(options.directory)
        }
        const handle = await open(temp, 'w', 0o644)
        try {
          await handle.writeFile(JSON.stringify(body))
        } finally {
          await handle.close()
        }
        await rename(temp, pathOf(udid))
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        options.onError?.(udid, error)
      }
    },

    async remove(udid: string): Promise<void> {
      if (!macOS) {
        return
      }
      await rm(pathOf(udid), { force: true }).catch((error: unknown) =>
        options.onError?.(udid, error)
      )
    }
  }
}
