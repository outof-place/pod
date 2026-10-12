// Fork-only (Pod): a PTY registered or exited. worktree.ps's liveTerminalCount moves with it and no
// hook row reports that (a sleep, a wake, a worktree's last shell closing), so the worktree status
// hub reads again. Electron-free: the runtime imports it.
const listeners = new Set<() => void>()

export function podTerminalLivenessChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A listener can't stop a PTY's lifecycle.
    }
  }
}

export function subscribePodTerminalLiveness(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
