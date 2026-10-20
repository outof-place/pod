// Fork-only (Pod): the desktop's worktree removal registry, shared with worktree.forgetLocal.
import { createWorktreeRemovalRegistry } from '../../ipc/worktrees/worktree-ipc-context'
import type { WorktreeRemovalInFlight } from '../../ipc/worktrees/removal/worktree-removal-coordinator'

let current: Map<string, WorktreeRemovalInFlight> | null = null

/** Records the registry registerWorktreeHandlers builds for its window, and returns it. */
export function setPodWorktreeRemovalRegistry(
  registry: Map<string, WorktreeRemovalInFlight>
): Map<string, WorktreeRemovalInFlight> {
  current = registry
  return registry
}

/**
 * The registry the window's removals and forgets use, so an RPC forget joins or refuses them. A
 * headless runtime has no window yet and gets its own, which a window attaching later replaces.
 * A forget the RPC started in that one before the window attached is then not seen by the window's
 * removals. Rare, and that forget changes only Pod's own state, so nothing tracks it across.
 */
export function getPodWorktreeRemovalRegistry(): Map<string, WorktreeRemovalInFlight> {
  current ??= createWorktreeRemovalRegistry()
  return current
}
