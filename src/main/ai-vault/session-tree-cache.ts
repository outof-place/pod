import type { Dirent, Stats } from 'node:fs'
import { sep } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'

/** One path the host's file watcher saw change. */
export type SessionTreeChange = { type: 'create' | 'update' | 'delete'; path: string }

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

// Why: FSEvents can coalesce a change away without flagging a drop, so a cold
// walk this often bounds how long a missed change can stay hidden.
export const SESSION_TREE_SAFETY_WALK_INTERVAL_MS = 10 * 60_000
// Why: a root whose watch failed is asked about again only this often, so a
// root the watcher refuses costs one failed subscribe per interval.
export const SESSION_TREE_WATCH_RETRY_INTERVAL_MS = 60_000

type TreeNode = {
  /** Bumped by every invalidation, so a read that raced one is not stored. */
  version: number
  entries?: Dirent[]
  stat?: SessionFileStat
  children?: Map<string, TreeNode>
}

function toFileStat(stats: Stats): SessionFileStat {
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink
  }
}

function invalidate(node: TreeNode): void {
  node.version++
  node.entries = undefined
  node.stat = undefined
}

/**
 * Directory listings and file stats under one watched root, kept until the
 * watcher reports a change to them.
 */
class WatchedSessionTree implements SessionTreeReader {
  private rootNode: TreeNode = { version: 0 }
  private generation = 0
  private builtAt: number
  private readonly prefix: string

  constructor(
    private readonly root: string,
    now: number
  ) {
    this.builtAt = now
    this.prefix = root.endsWith(sep) ? root : `${root}${sep}`
  }

  reset(now: number): void {
    this.rootNode = { version: 0 }
    this.generation++
    this.builtAt = now
  }

  resetIfDue(now: number): void {
    if (now - this.builtAt >= SESSION_TREE_SAFETY_WALK_INTERVAL_MS) {
      this.reset(now)
    }
  }

  readDirectory = async (dirPath: string): Promise<Dirent[]> => {
    const node = this.nodeFor(dirPath)
    if (!node) {
      return wslGatedReaddir(dirPath, 'scan')
    }
    if (node.entries) {
      return node.entries
    }
    const { version } = node
    const { generation } = this
    const entries = await wslGatedReaddir(dirPath, 'scan')
    if (node.version === version && this.generation === generation) {
      node.entries = entries
    }
    return entries
  }

  stat = async (path: string): Promise<SessionFileStat> => {
    const node = this.nodeFor(path)
    if (!node) {
      return toFileStat(await wslGatedStat(path, 'scan'))
    }
    if (node.stat) {
      return node.stat
    }
    const { version } = node
    const { generation } = this
    const fileStat = toFileStat(await wslGatedStat(path, 'scan'))
    if (node.version === version && this.generation === generation) {
      node.stat = fileStat
    }
    return fileStat
  }

  apply(change: SessionTreeChange, now: number): void {
    const segments = this.segmentsOf(change.path)
    if (!segments) {
      return
    }
    const name = segments.at(-1)
    if (name === undefined) {
      if (change.type === 'update') {
        invalidate(this.rootNode)
      } else {
        this.reset(now)
      }
      return
    }
    const parent = this.find(segments, segments.length - 1)
    if (!parent) {
      return
    }
    if (change.type === 'update') {
      const node = parent.children?.get(name)
      if (node) {
        invalidate(node)
      }
      return
    }
    // A create or delete changes the parent's listing, and anything cached
    // under this name described a file or directory that is no longer there.
    invalidate(parent)
    parent.children?.delete(name)
  }

  private segmentsOf(path: string): string[] | null {
    if (path === this.root) {
      return []
    }
    return path.startsWith(this.prefix) ? path.slice(this.prefix.length).split(sep) : null
  }

  private find(segments: readonly string[], count: number): TreeNode | undefined {
    let node: TreeNode | undefined = this.rootNode
    for (let index = 0; index < count && node; index++) {
      node = node.children?.get(segments[index])
    }
    return node
  }

  private nodeFor(path: string): TreeNode | undefined {
    const segments = this.segmentsOf(path)
    if (!segments) {
      return undefined
    }
    let node = this.rootNode
    for (const segment of segments) {
      node.children ??= new Map()
      let child = node.children.get(segment)
      if (!child) {
        child = { version: 0 }
        node.children.set(segment, child)
      }
      node = child
    }
    return node
  }
}

const watchedTrees = new Map<string, WatchedSessionTree>()
const watchRequestHeldUntil = new Map<string, number>()
let requestWatch: ((root: string) => void) | null = null

/** Installed by a process whose host can watch roots; without it discovery reads disk as before. */
export function installSessionTreeWatchRequests(request: (root: string) => void): void {
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
    return tree
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
    stat: async (path) => toFileStat(await wslGatedStat(path, 'scan'))
  }
}

function askToWatch(root: string): void {
  const now = Date.now()
  if ((watchRequestHeldUntil.get(root) ?? 0) > now) {
    return
  }
  watchRequestHeldUntil.set(root, now + SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
  requestWatch?.(root)
}

export function applySessionTreeWatchState(root: string, state: SessionTreeWatchState): void {
  const now = Date.now()
  if (state === 'lost') {
    watchedTrees.delete(root)
    watchRequestHeldUntil.set(root, now + SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
    return
  }
  const tree = watchedTrees.get(root)
  if (tree) {
    tree.reset(now)
    return
  }
  if (state === 'live') {
    watchedTrees.set(root, new WatchedSessionTree(root, now))
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
  watchedTrees.clear()
  watchRequestHeldUntil.clear()
  requestWatch = null
}
