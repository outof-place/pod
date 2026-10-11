// Fork-only (Pod): the Computer Use actions agents ran, as clients show them.

/** One action: what it was, in which app, for which caller target, and how it went. */
export type PodComputerActionRow = {
  /** Increases by one per action since the runtime started. */
  seq: number
  /** Epoch ms when the action started. */
  at: number
  /** The method without `computer.`: click, typeText, hotkey, … */
  action: string
  /** The app as the caller named it (bundle id or name). */
  app: string
  /** The caller's own target, when it gave one: a worktree selector or a terminal session. */
  worktree: string | null
  session: string | null
  ok: boolean
  ms: number
}

export type PodComputerActionsEvent =
  | { type: 'ready'; subscriptionId: string; actions: PodComputerActionRow[] }
  | { type: 'actions'; rows: PodComputerActionRow[] }
  | { type: 'end' }

export const POD_COMPUTER_ACTIONS_RPC = {
  subscribe: 'computer.actions',
  unsubscribe: 'computer.unsubscribeActions'
} as const
