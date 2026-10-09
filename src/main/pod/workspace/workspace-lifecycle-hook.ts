// Dependency-free so startup modules can call it without importing the workspace feature.

export type WorkspaceWorktreeLifecycleEvent =
  | { kind: 'created'; worktreeId: string; path: string }
  | { kind: 'removed'; worktreeId: string; path: string }

let handler: ((event: WorkspaceWorktreeLifecycleEvent) => void) | null = null

export function setPodWorkspaceWorktreeLifecycleHandler(
  next: ((event: WorkspaceWorktreeLifecycleEvent) => void) | null
): void {
  handler = next
}

/** Worktree creates and removals from the IPC path; runtime ones are subscribed directly. */
export function notifyPodWorkspaceWorktreeLifecycle(event: WorkspaceWorktreeLifecycleEvent): void {
  handler?.(event)
}
