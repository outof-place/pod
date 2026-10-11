// Fork-only (Pod): `terminal.processes`, each local terminal's root process for native clients.

/** One live terminal on this Mac and the process its PTY runs. */
export type PodTerminalProcess = {
  ptyId: string
  /** The worktree the PTY belongs to, when the terminal host records it. */
  worktreeId?: string
  /** The terminal's handle (ORCA_TERMINAL_HANDLE), when the host knows it. */
  handle?: string
  /** The PTY's own root process (the shell); absent when the host can't prove it. */
  shellPid?: number
}

export type PodTerminalProcessesResult = {
  terminals: PodTerminalProcess[]
}
