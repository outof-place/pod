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

/**
 * ssh.listTargetConfigs, addTarget, updateTarget, removeTarget, importConfig and disconnect: SSH
 * settings without Pod's window. A client shows its SSH host editor only on a host that lists this.
 */
export const POD_SSH_TARGET_SETTINGS_RUNTIME_CAPABILITY = 'pod.ssh.target-settings.v1' as const

/**
 * ssh.browseDir and repo.addRemote: Add Project on an SSH host without Pod's window. A client offers
 * a remote folder only on a host that lists this.
 */
export const POD_SSH_REMOTE_PROJECTS_RUNTIME_CAPABILITY = 'pod.ssh.remote-projects.v1' as const

/** aiVault.deleteSession: the AI vault's Delete without Pod's window. */
export const POD_AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY =
  'pod.ai-vault.delete-session.v1' as const

/**
 * podSettings.getNetworkProxy and setNetworkProxy: the proxy URL, a secret podSettings' fields leave
 * out, for this machine's own clients.
 */
export const POD_SETTINGS_NETWORK_PROXY_RUNTIME_CAPABILITY =
  'pod.settings.network-proxy.v1' as const

/**
 * sim.*: iOS simulators for agents (lease, drive, release; the pool snapshot and its stream). A
 * client shows simulator UI, and the CLI calls sim.*, only on a host that lists this. Not listed
 * below until the sim.* handlers land (stage 7): a runtime never advertises what it cannot serve.
 */
export const POD_SIM_RUNTIME_CAPABILITY = 'pod.sim.v1' as const

export const POD_RUNTIME_CAPABILITIES = [
  POD_CREATE_TERMINAL_AGENT_ARGS_RUNTIME_CAPABILITY,
  POD_TERMINAL_OPENED_BEFORE_CLAUDE_ACCOUNTS_RUNTIME_CAPABILITY,
  POD_SSH_TARGET_SETTINGS_RUNTIME_CAPABILITY,
  POD_SSH_REMOTE_PROJECTS_RUNTIME_CAPABILITY,
  POD_AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY,
  POD_SETTINGS_NETWORK_PROXY_RUNTIME_CAPABILITY
] as const
