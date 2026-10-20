// Fork-only (Pod): the forget worktree.forgetLocal calls, as startup installs it. Kept apart from the
// forget itself, which reaches the desktop's worktree IPC modules and through them Electron, so the
// runtime's method table never imports them (check-runtime-electron-ratchet).

export type PodWorktreeForgetLocalParams = { worktreeId: string; hostId: string }
export type PodWorktreeForgetLocal = (params: PodWorktreeForgetLocalParams) => Promise<void>

let installed: PodWorktreeForgetLocal | null = null

export function setPodWorktreeForgetLocal(forget: PodWorktreeForgetLocal | null): void {
  installed = forget
}

export function getPodWorktreeForgetLocal(): PodWorktreeForgetLocal | null {
  return installed
}
