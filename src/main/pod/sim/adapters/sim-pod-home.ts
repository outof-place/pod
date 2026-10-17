// Fork-only (Pod): where the simulator pool lives on this Mac. One home for the whole account,
// never a Pod profile, so a probe runtime and the user's Pod share one pool: Pod's own device set
// (so a running Simulator.app, which watches the default set, never opens a window for a pool
// device) and the flocked registry beside it. POD_SIM_HOME moves both (tests, probes).
//
// Before anything is created or written there, the home is claimed: only on macOS, never where
// its device set would be Xcode's default or testing set (whatever links lead there), and only in
// a directory the pool made and marked (or an empty one it marks), so a mistyped POD_SIM_HOME
// cannot point the pool's deletes at someone else's simulators.
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import {
  SIM_POD_DEVICE_SET_DIRECTORY,
  SIM_POD_HOME_DIRECTORY,
  SIM_REGISTRY_FILE_NAME,
  SIM_REGISTRY_LOCK_FILE_NAME
} from '../../../../shared/pod-sim/sim-registry'

export const POD_SIM_HOME_ENV = 'POD_SIM_HOME'
/** The file that says the pool made this directory. */
export const SIM_POD_HOME_MARKER = '.pod-sim-home'

export type SimPodHome = Readonly<{
  root: string
  deviceSet: string
  registry: string
  lock: string
}>

export function simPodHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): SimPodHome {
  const override = env[POD_SIM_HOME_ENV]
  const expanded =
    override === '~' || override?.startsWith('~/') ? join(home, override.slice(1)) : override
  const root = expanded ? resolve(expanded) : join(home, ...SIM_POD_HOME_DIRECTORY)
  return {
    root,
    deviceSet: join(root, ...SIM_POD_DEVICE_SET_DIRECTORY),
    registry: join(root, SIM_REGISTRY_FILE_NAME),
    lock: join(root, SIM_REGISTRY_LOCK_FILE_NAME)
  }
}

export type SimPodHomeClaim =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'notMacOS' | 'registryUnreadable'; message: string }>

export type SimPodHomeClaimOptions = Readonly<{
  platform?: NodeJS.Platform
  userHome?: string
}>

function errnoOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** The path with every link in its longest existing prefix resolved. */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if (errnoOf(error) !== 'ENOENT' || parent === path) {
      throw error
    }
    return join(await realPathOf(parent), path.slice(parent.length + 1))
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function refused(message: string): SimPodHomeClaim {
  return { ok: false, reason: 'registryUnreadable', message }
}

/** Makes the home Pod's, or says why it is not; creates the root and its marker only. */
export async function claimSimPodHome(
  home: SimPodHome,
  options: SimPodHomeClaimOptions = {}
): Promise<SimPodHomeClaim> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { ok: false, reason: 'notMacOS', message: 'the simulator pool runs only on macOS' }
  }
  const developer = join(options.userHome ?? homedir(), 'Library', 'Developer')
  try {
    const set = await realPathOf(home.deviceSet)
    for (const xcode of ['CoreSimulator', 'XCTestDevices']) {
      if (inside(set, await realPathOf(join(developer, xcode)))) {
        return refused(
          `${home.deviceSet} is Xcode's own device set (${xcode}); Pod keeps its simulators apart (check ${POD_SIM_HOME_ENV})`
        )
      }
    }
    await mkdir(home.root, { recursive: true, mode: 0o700 })
    const entries = await readdir(home.root)
    if (entries.includes(SIM_POD_HOME_MARKER)) {
      return { ok: true }
    }
    if (entries.length > 0) {
      return refused(
        `${home.root} holds files the simulator pool did not make; Pod uses only a directory it made (check ${POD_SIM_HOME_ENV})`
      )
    }
    await writeFile(join(home.root, SIM_POD_HOME_MARKER), 'Pod simulator pool\n', {
      mode: 0o600,
      flag: 'wx'
    }).catch((error: unknown) => {
      // Another runtime marked it first.
      if (errnoOf(error) !== 'EEXIST') {
        throw error
      }
    })
    return { ok: true }
  } catch (error) {
    return refused(`${home.root} cannot be used for the simulator pool: ${String(error)}`)
  }
}

/** One claim per home and process: kept once it succeeds, asked again after a refusal. */
export function simPodHomeClaimer(
  home: SimPodHome,
  options: SimPodHomeClaimOptions = {}
): () => Promise<SimPodHomeClaim> {
  let claimed: Promise<SimPodHomeClaim> | null = null
  return async () => {
    claimed ??= claimSimPodHome(home, options)
    const claim = await claimed
    if (!claim.ok) {
      claimed = null
    }
    return claim
  }
}

const UDID_DIRECTORY = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

/**
 * UDIDs with a directory in Pod's device set: what is on disk, whatever simctl says. One readdir,
 * a fraction of a millisecond. A set not made yet is empty; one that cannot be read is null, never
 * an empty set (that would read as every device gone).
 */
export async function simDevicesOnDisk(deviceSet: string): Promise<Set<string> | null> {
  try {
    const entries = await readdir(deviceSet)
    return new Set(entries.filter((entry) => UDID_DIRECTORY.test(entry)))
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? new Set() : null
  }
}
