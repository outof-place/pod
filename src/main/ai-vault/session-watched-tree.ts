import type { Dirent } from 'node:fs'
import { sep } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import type { SessionFileStat, SessionTreeChange, SessionTreeReader } from './session-tree-cache'
import type { SessionTreeCacheBudget } from './session-tree-cache-budget'

export const SESSION_TREE_SAFETY_WALK_INTERVAL_MS = 10 * 60_000
const DIRECTORY_ENTRY_OVERHEAD_BYTES = 192
const TREE_NODE_OVERHEAD_BYTES = 256

type TreeNode = {
  /** Bumped by every invalidation, so a read that raced one is not stored. */
  version: number
  bytes: number
  entries?: Dirent[]
  entriesBytes?: number
  stat?: SessionFileStat
  children?: Map<string, TreeNode>
}

export async function readSessionFileStat(path: string): Promise<SessionFileStat> {
  const stats = await wslGatedStat(path, 'scan')
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink
  }
}

/** Cached filesystem observations owned by one live root subscription. */
export class WatchedSessionTree implements SessionTreeReader {
  private rootNode: TreeNode = { version: 0, bytes: 0 }
  private generation = 0
  private builtAt: number
  private readonly prefix: string
  private retained = 0
  private retainedBytes = 0
  private active = true

  constructor(
    private readonly root: string,
    now: number,
    private readonly budget: SessionTreeCacheBudget
  ) {
    this.builtAt = now
    this.prefix = root.endsWith(sep) ? root : `${root}${sep}`
  }

  reset(now: number): void {
    this.budget.release(this.retained, this.retainedBytes)
    this.retained = 0
    this.retainedBytes = 0
    this.rootNode = { version: 0, bytes: 0 }
    this.generation++
    this.builtAt = now
  }

  dispose(): void {
    this.reset(Date.now())
    this.active = false
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
    const bytes = entries.reduce(
      (total, entry) =>
        total + DIRECTORY_ENTRY_OVERHEAD_BYTES + 2 * (entry.name.length + entry.parentPath.length),
      0
    )
    if (
      !node.entries &&
      node.version === version &&
      this.generation === generation &&
      this.reserve(entries.length, bytes)
    ) {
      node.entries = entries
      node.entriesBytes = bytes
    }
    return entries
  }

  stat = async (path: string): Promise<SessionFileStat> => {
    const node = this.nodeFor(path)
    if (!node) {
      return readSessionFileStat(path)
    }
    if (node.stat) {
      return node.stat
    }
    const { version } = node
    const { generation } = this
    const fileStat = await readSessionFileStat(path)
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
      this.reset(now)
      return
    }
    const parent = this.find(segments, segments.length - 1)
    if (!parent) {
      return
    }
    if (change.type === 'update') {
      const node = parent.children?.get(name)
      if (node) {
        const directory = change.isDirectory || node.entries !== undefined || node.children
        this.invalidate(node)
        if (directory) {
          this.dropChildren(node)
          this.invalidate(parent)
        }
      }
      return
    }
    // A create or delete changes the parent's listing, and anything cached
    // under this name described a file or directory that is no longer there.
    this.invalidate(parent)
    const removed = parent.children?.get(name)
    if (removed) {
      this.invalidate(removed)
      this.dropChildren(removed)
      this.release(1, removed.bytes)
    }
    parent.children?.delete(name)
  }

  private reserve(count: number, bytes: number): boolean {
    if (!this.budget.reserve(count, bytes)) {
      return false
    }
    this.retained += count
    this.retainedBytes += bytes
    return true
  }

  private release(count: number, bytes: number): void {
    this.budget.release(count, bytes)
    this.retained -= count
    this.retainedBytes -= bytes
  }

  private invalidate(node: TreeNode): void {
    this.release(node.entries?.length ?? 0, node.entriesBytes ?? 0)
    node.version++
    node.entries = undefined
    node.entriesBytes = undefined
    node.stat = undefined
  }

  private dropChildren(node: TreeNode): void {
    const pending = [...(node.children?.values() ?? [])]
    node.children = undefined
    for (const child of pending) {
      for (const descendant of child.children?.values() ?? []) {
        pending.push(descendant)
      }
      child.children = undefined
      this.invalidate(child)
      this.release(1, child.bytes)
    }
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
    if (!this.active) {
      return undefined
    }
    const segments = this.segmentsOf(path)
    if (!segments) {
      return undefined
    }
    let node = this.rootNode
    for (const segment of segments) {
      node.children ??= new Map()
      let child = node.children.get(segment)
      if (!child) {
        // A sliced segment can retain its complete source path in V8.
        const bytes = TREE_NODE_OVERHEAD_BYTES + 2 * path.length
        if (!this.reserve(1, bytes)) {
          return undefined
        }
        child = { version: 0, bytes }
        node.children.set(segment, child)
      }
      node = child
    }
    return node
  }
}
