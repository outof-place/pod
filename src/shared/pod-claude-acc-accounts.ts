// Fork-only (Pod): Claude accounts belong to claude-acc. Settings shows claude-acc's own accounts
// and adds, signs in and switches them through `claude-acc`, so Pod never makes a profile account
// (#26801) of its own that claude-acc could only show read-only.

export const POD_CLAUDE_ACC_IPC = {
  list: 'podClaudeAcc:list',
  add: 'podClaudeAcc:add',
  signInAgain: 'podClaudeAcc:signInAgain',
  switchTo: 'podClaudeAcc:switch',
  cancel: 'podClaudeAcc:cancel'
} as const

export type PodClaudeAccWindow = {
  /** Percent used, 0-100. */
  used: number | null
  /** Unix seconds. */
  resetsAt: number | null
}

export type PodClaudeAccAccount = {
  email: string
  active: boolean
  /** In the rotation with headroom: auto-switch may take it. */
  usable: boolean
  needsSignIn: boolean
  /** A Pod profile row: usage only, claude-acc never switches to it. */
  podProfile: boolean
  /** claude-acc's own line for the row (Polish, as the scripts print it). */
  note: string | null
  session: PodClaudeAccWindow | null
  weekly: PodClaudeAccWindow | null
}

export type PodClaudeAccState = {
  /** claude-acc is installed and its account tick has written a snapshot. */
  available: boolean
  /** Unix seconds of the snapshot. */
  generatedAt: number | null
  accounts: PodClaudeAccAccount[]
}

export type PodClaudeAccResult = {
  ok: boolean
  /** The script's last line: its own sentence for success or for the refusal. */
  message: string
  cancelled: boolean
  state: PodClaudeAccState
}
