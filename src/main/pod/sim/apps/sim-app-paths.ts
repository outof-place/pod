// Fork-only (Pod): where the app module keeps its Mac-wide state, inside the simulator home beside
// the registry (POD_SIM_HOME moves all of it): the dev-client cache and its builds, the Metro plan,
// what Pod installed on each device, and the local recipe override.
//
//   clients/<bundleId>/<fingerprint>.app   a dev client, one per native fingerprint
//   clients/<bundleId>/<fingerprint>.json  its size, where it came from, when it was last used
//   clients/builds.json (+ .lock)          builds in flight, failed and done, flocked like the registry
//   clients/logs/<buildId>.log, .status    each build's output and exit code
//   metro.json (+ .lock)                   each worktree's Metro port and process
//   metro/<worktree hash>-<app>.log        each Metro's output
//   installed/<udid>.json                  the client and Metro each device last got from Pod
//   recipes.yaml                           local recipes, keyed by repo, over pod.yaml and orca.yaml
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SimPodHome } from '../adapters/sim-pod-home'

export type SimAppHome = Readonly<{
  root: string
  clients: string
  builds: string
  buildsLock: string
  buildLogs: string
  metro: string
  metroLock: string
  metroLogs: string
  installed: string
  recipes: string
}>

export function simAppHome(home: SimPodHome): SimAppHome {
  const clients = join(home.root, 'clients')
  return {
    root: home.root,
    clients,
    builds: join(clients, 'builds.json'),
    buildsLock: join(clients, 'builds.lock'),
    buildLogs: join(clients, 'logs'),
    metro: join(home.root, 'metro.json'),
    metroLock: join(home.root, 'metro.lock'),
    metroLogs: join(home.root, 'metro'),
    installed: join(home.root, 'installed'),
    recipes: join(home.root, 'recipes.yaml')
  }
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
// A path segment of its own: never `.`, `..` or a separator.
const FINGERPRINT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/

export function isSimFingerprint(value: string): boolean {
  return FINGERPRINT.test(value) && value !== '..'
}

/** `<dir>/<fingerprint>.app`, or null for a bundle id or fingerprint that could leave `dir`. */
export function simClientIn(dir: string, bundleId: string, fingerprint: string): string | null {
  return BUNDLE_ID.test(bundleId) && isSimFingerprint(fingerprint)
    ? join(dir, `${fingerprint}.app`)
    : null
}

export function simClientDir(home: SimAppHome, bundleId: string): string | null {
  return BUNDLE_ID.test(bundleId) ? join(home.clients, bundleId) : null
}

/** A short stable name for a worktree in file names. */
export function simWorktreeTag(worktreeRoot: string): string {
  return createHash('sha256').update(worktreeRoot).digest('hex').slice(0, 12)
}
