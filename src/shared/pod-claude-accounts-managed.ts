// Fork-only (Pod): claude-acc is the only owner of Claude accounts in Pod. Pod's own account
// actions (#26801 profiles: sign in, select, remove) refuse with this code, so no surface can make
// a profile claude-acc only shows read-only, or a selection that stops claude-acc's switching.

export const POD_CLAUDE_ACCOUNTS_MANAGED_CODE = 'claude_accounts_managed_by_claude_acc'

export const POD_CLAUDE_ACCOUNTS_MANAGED_MESSAGE =
  'Claude accounts are managed by claude-acc. Add one with `claude-acc add`, or switch with `claude-acc switch <email>`.'

export class PodClaudeAccountsManagedError extends Error {
  readonly code = POD_CLAUDE_ACCOUNTS_MANAGED_CODE

  constructor() {
    super(POD_CLAUDE_ACCOUNTS_MANAGED_MESSAGE)
    this.name = 'PodClaudeAccountsManagedError'
  }
}
