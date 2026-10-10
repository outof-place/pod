import { realpath } from 'node:fs/promises'
import type { OgdClient } from './ogd-client'
import { isOgdMessage } from './ogd-connection'

/** ogd's view of one indexed root, for Pod workspace UI. */
export type PodSearchIndexStatus = {
  /** ogd's lifecycle state, e.g. "ready", "building" or "failed". */
  state: string
  docs: number
  generation: number
  /** False while ogd still waits for file events to settle; queries then fall back to rg. */
  settled: boolean
  buildMs: number
}

/** One `status` call, matched by realpath; null when the root is not indexed or ogd is away. */
export async function readOgdIndexStatus(
  client: OgdClient,
  root: string
): Promise<PodSearchIndexStatus | null> {
  try {
    const [canonicalRoot, reply] = await Promise.all([realpath(root), client.request('status')])
    const worktrees = reply.message.worktrees
    for (const worktree of Array.isArray(worktrees) ? worktrees : []) {
      if (!isOgdMessage(worktree) || worktree.root !== canonicalRoot) {
        continue
      }
      return {
        state: String(worktree.state),
        docs: Number(worktree.docs) || 0,
        generation: Number(worktree.generation) || 0,
        settled: worktree.unsettled === null || worktree.unsettled === undefined,
        buildMs: Number(worktree.build_ms) || 0
      }
    }
    return null
  } catch {
    return null
  }
}
