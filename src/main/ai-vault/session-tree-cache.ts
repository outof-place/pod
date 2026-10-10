import type { Dirent, Stats } from 'node:fs'
import { BoundedMap } from '../../shared/bounded-map'
import { readSessionFileStat, WatchedSessionTree } from './session-watched-tree'
import { SessionTreeCacheBudget, SESSION_TREE_CACHE_MAX_ROOTS } from './session-tree-cache-budget'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
export { SESSION_TREE_SAFETY_WALK_INTERVAL_MS } from './session-watched-tree'

/** One path the host's file watcher saw change. */
export type SessionTreeChange = {
  type: 'create' | 'update' | 'delete'
  path: string
  isDirectory?: boolean
}
export type SessionTreeRootIdentity = Pick<Stats, 'dev' | 'ino'>

/**
 * What the host reports about a root's subscription:
 * - `live`: subscribed; every change from now on arrives as a change event.
 * - `reset`: still subscribed, but some events were lost (overflow, watcher restart).
 * - `lost`: no longer subscribed.
 */
export type SessionTreeWatchState = 'live' | 'reset' | 'lost'

/** The parts of a stat discovery reads. */
export type SessionFileStat = Pick<Stats, 'mtimeMs' | 'size' | 'dev' | 'ino' | 'nlink'>

export type SessionTreeReader = {
  readDirectory: (dirPath: string) => Promise<Dirent[]>
  stat: (path: string) => Promise<SessionFileStat>
}

// Why: a root whose watch failed is asked about again only this often, so a
// root the watcher refuses costs one failed subscribe per interval.
export const SESSION_TREE_WATCH_RETRY_INTERVAL_MS = 60_000

const budget = new SessionTreeCacheBudget()
const rootIdentities = new Map<string, SessionTreeRootIdentity>()
const watchedTrees = new BoundedMap<string, WatchedSessionTree>({
  maxEntries: SESSION_TREE_CACHE_MAX_ROOTS,
  onEvict: (tree, root) => {
    tree.dispose()
    rootIdentities.delete(root)
  }
})
const watchRequestHeldUntil = new BoundedMap<string, number>({ maxEntries: 256 })
let requestWatch: ((root: string, restart?: boolean) => void) | null = null

/** Installed by a process whose host can watch roots; without it discovery reads disk as before. */
export function installSessionTreeWatchRequests(
  request: (root: string, restart?: boolean) => void
): void {
  requestWatch = request
}

/** How discovery reads `root`, or null to use the gated fs primitives directly. */
export function sessionTreeReader(root: string): SessionTreeReader | null {
  if (!requestWatch) {
    return null
  }
  const tree = watchedTrees.get(root)
  if (tree) {
    tree.resetIfDue(Date.now())
    return {
      readDirectory: async (dirPath) => {
        if (dirPath === root && watchedTrees.peek(root) === tree) {
          try {
            const identity = await wslGatedStat(root, 'scan')
            if (watchedTrees.peek(root) !== tree) {
              return tree.readDirectory(dirPath)
            }
            const previous = rootIdentities.get(root)
            if (previous && (previous.dev !== identity.dev || previous.ino !== identity.ino)) {
              retireTree(root, tree)
              askToWatch(root, true)
            } else {
              rootIdentities.set(root, { dev: identity.dev, ino: identity.ino })
            }
          } catch (error) {
            retireTree(root, tree)
            askToWatch(root, true)
            throw error
          }
        }
        return tree.readDirectory(dirPath)
      },
      stat: tree.stat
    }
  }
  return {
    readDirectory: async (dirPath) => {
      const entries = await wslGatedReaddir(dirPath, 'scan')
      // Only a root that exists is worth a subscription; most agents have none here.
      if (dirPath === root) {
        askToWatch(root)
      }
      return entries
    },
    stat: readSessionFileStat
  }
}

function askToWatch(root: string, restart?: boolean): void {
  const now = Date.now()
  if (!restart && (watchRequestHeldUntil.get(root) ?? 0) > now) {
    return
  }
  watchRequestHeldUntil.set(root, now + SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
  requestWatch?.(root, restart)
}

function retireTree(root: string, tree: WatchedSessionTree): void {
  tree.dispose()
  if (watchedTrees.peek(root) === tree) {
    watchedTrees.delete(root)
    rootIdentities.delete(root)
  }
}

export function refreshSessionTreeCache(): void {
  const now = Date.now()
  for (const tree of watchedTrees.values()) {
    tree.reset(now)
  }
}

export function applySessionTreeWatchState(
  root: string,
  state: SessionTreeWatchState,
  identity?: SessionTreeRootIdentity
): void {
  const now = Date.now()
  if (state === 'lost') {
    const tree = watchedTrees.peek(root)
    if (tree) {
      retireTree(root, tree)
    }
    watchRequestHeldUntil.set(root, now + SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
    return
  }
  const tree = watchedTrees.get(root)
  if (identity) {
    rootIdentities.set(root, identity)
  }
  if (tree) {
    tree.reset(now)
    return
  }
  if (state === 'live') {
    watchedTrees.set(root, new WatchedSessionTree(root, now, budget))
  }
}

export function applySessionTreeChanges(root: string, changes: readonly SessionTreeChange[]): void {
  const tree = watchedTrees.get(root)
  if (!tree) {
    return
  }
  const now = Date.now()
  for (const change of changes) {
    tree.apply(change, now)
  }
}

/** Evicts paths the host already knows are gone, ahead of the watcher's own event. */
export function forgetSessionTreePaths(paths: readonly string[]): void {
  const now = Date.now()
  for (const tree of watchedTrees.values()) {
    for (const path of paths) {
      tree.apply({ type: 'delete', path }, now)
    }
  }
}

export function resetSessionTreeCacheForTests(): void {
  for (const tree of watchedTrees.values()) {
    tree.dispose()
  }
  watchedTrees.clear()
  rootIdentities.clear()
  watchRequestHeldUntil.clear()
  requestWatch = null
}
