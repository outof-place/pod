// Fork-only (Pod): runtime capabilities only Pod's hosts advertise (status.get `capabilities`).

/**
 * session.tabs.createTerminal takes `agentArgs`. An older host's schema drops the unknown key and
 * starts the agent with its configured arguments, which looks like success, so a client sends
 * `agentArgs` only to a host that advertises this.
 */
export const POD_CREATE_TERMINAL_AGENT_ARGS_RUNTIME_CAPABILITY =
  'pod.session-tabs.create-terminal-agent-args.v1' as const

/**
 * pod.terminal.openedBeforeClaudeAccounts: whether a pane's shell predates per-account Claude
 * folders, so its `claude` runs System default's login. A client asks only a host that lists this.
 */
export const POD_TERMINAL_OPENED_BEFORE_CLAUDE_ACCOUNTS_RUNTIME_CAPABILITY =
  'pod.terminal.opened-before-claude-accounts.v1' as const

export const POD_RUNTIME_CAPABILITIES = [
  POD_CREATE_TERMINAL_AGENT_ARGS_RUNTIME_CAPABILITY,
  POD_TERMINAL_OPENED_BEFORE_CLAUDE_ACCOUNTS_RUNTIME_CAPABILITY
] as const
