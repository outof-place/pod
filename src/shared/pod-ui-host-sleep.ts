// Fork-only (Pod): renderer → main, around a Close Terminals in the one-app runtime's window.
export const POD_UI_HOST_SLEEP_IPC = {
  /** Sent before the renderer stops its panes' PTYs. */
  begin: 'pod:uiHostSleep:begin',
  /** Invoked after: the runtime sleeps what is left and holds the worktree asleep. */
  runtimeTerminals: 'pod:uiHostSleep:runtimeTerminals'
} as const
