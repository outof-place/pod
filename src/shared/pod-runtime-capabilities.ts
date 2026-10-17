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

/**
 * ssh.credentialPrompts.subscribe and ssh.submitCredential: SSH connect prompts without Pod's
 * window. A host without them answers a prompt it cannot show with a cancel, so a client connects
 * hosts that need a passphrase or password only where this is listed.
 */
export const POD_SSH_CREDENTIAL_PROMPTS_RUNTIME_CAPABILITY =
  'pod.ssh.credential-prompts.v1' as const

/**
 * ssh.listPortForwards, addPortForward, updatePortForward, removePortForward, listDetectedPorts and
 * the ssh.ports stream: SSH port forwarding without Pod's window.
 */
export const POD_SSH_PORT_FORWARDS_RUNTIME_CAPABILITY = 'pod.ssh.port-forwards.v1' as const

/** aiVault.deleteSession: the AI vault's Delete without Pod's window. */
export const POD_AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY =
  'pod.ai-vault.delete-session.v1' as const

/**
 * podSettings.getNetworkProxy and setNetworkProxy: the proxy URL, a secret podSettings' fields leave
 * out, for this machine's own clients.
 */
export const POD_SETTINGS_NETWORK_PROXY_RUNTIME_CAPABILITY =
  'pod.settings.network-proxy.v1' as const

/** podImport.orcaDetect, orcaPreview and orcaApply: Import from Orca, for this machine's own clients. */
export const POD_ORCA_IMPORT_RUNTIME_CAPABILITY = 'pod.orca-import.v1' as const

/**
 * plugins.install, remove and the marketplace calls: Settings › Plugins without Pod's window. A
 * client offers them only on a host that lists this.
 */
export const POD_PLUGINS_MANAGE_RUNTIME_CAPABILITY = 'pod.plugins.manage.v1' as const

/**
 * host.setDisplayLabel, repo.removeSparsePreset, and repo.update taking `worktreeBaseRef: null` or ""
 * as a clear, for every RPC client (mobile's repo.update included, where both did nothing before).
 * An older host drops that null and keeps the base ref, so a client offers Reset only here.
 */
export const POD_WORKSPACE_ROWS_RUNTIME_CAPABILITY = 'pod.workspace-rows.v1' as const

/**
 * notifications.sources, `notificationSourceId` on notifications.subscribe's alerts, and
 * podSettings' notifications.mutedNotificationSourceIds: per-machine mutes without Pod's window.
 */
export const POD_NOTIFICATION_SOURCES_RUNTIME_CAPABILITY = 'pod.notifications.sources.v1' as const

/**
 * A failed local shell (exit above 0) keeps its pane with `terminalExit` in session tabs, and
 * session.tabs.restartTerminal starts a shell in it. Older hosts retire the pane on exit.
 */
export const POD_SESSION_TABS_RESTART_TERMINAL_RUNTIME_CAPABILITY =
  'pod.session-tabs.restart-terminal.v1' as const

/**
 * session.tabs.updatePaneLayout from this machine's PodNative reaches the one-app window's renderer
 * (splits, expanded pane), and takes `activeLeafId` on both paths without focusing anything.
 * Older hosts answer `updated: true` and drop the layout while their window runs.
 */
export const POD_SESSION_TABS_PANE_LAYOUT_SYNC_RUNTIME_CAPABILITY =
  'pod.session-tabs.pane-layout-sync.v1' as const

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
  POD_SSH_CREDENTIAL_PROMPTS_RUNTIME_CAPABILITY,
  POD_SSH_PORT_FORWARDS_RUNTIME_CAPABILITY,
  POD_AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY,
  POD_SETTINGS_NETWORK_PROXY_RUNTIME_CAPABILITY,
  POD_PLUGINS_MANAGE_RUNTIME_CAPABILITY,
  POD_WORKSPACE_ROWS_RUNTIME_CAPABILITY,
  POD_NOTIFICATION_SOURCES_RUNTIME_CAPABILITY,
  POD_SESSION_TABS_RESTART_TERMINAL_RUNTIME_CAPABILITY,
  POD_SESSION_TABS_PANE_LAYOUT_SYNC_RUNTIME_CAPABILITY,
  POD_ORCA_IMPORT_RUNTIME_CAPABILITY
] as const
