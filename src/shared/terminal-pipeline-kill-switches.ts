/** The terminal pipeline's kill switches in GlobalSettings: hidden-pane parking and main's model work. */
export type TerminalPipelineKillSwitches = {
  /** Kill switch for hidden terminal view parking: unmount long-hidden panes while a pane-less watcher keeps PTY side effects alive. */
  terminalHiddenViewParking?: boolean
  /** Kill switch for SSH terminal parking (C1): SSH panes park like local ones; reveal restores from main's headless model, falling back to relay replay. */
  terminalSshViewParking?: boolean
  /** Kill switch for the hidden-worktree retention budget (C1): force-parks the least-recently-hidden un-parkable worktrees beyond a count budget or TTL. */
  terminalHiddenWorktreeRetentionBudget?: boolean
  /** Kill switch for main-process PTY side-effect authority; on (default) = title/bell/agent facts via pty:sideEffect channel, not renderer byte parsing. */
  terminalMainSideEffectAuthority?: boolean
  /** Kill switch for main's hidden-delivery gate (Phase 4): drops PTY bytes to hidden views after model ingestion; requires terminalMainSideEffectAuthority. */
  terminalHiddenDeliveryGate?: boolean
  /** Kill switch for main's model query responder (Phase 5); active only when both Phase-4 gates are also on. */
  terminalModelQueryAuthority?: boolean
  /** Kill switch for dropping main's model of a visible local daemon PTY nothing reads; demand rebuilds it from the daemon snapshot. */
  terminalMainModelDormancy?: boolean
  /** Kill switch for handing a hidden local daemon PTY's query replies to the daemon (protocol 45+), so main's model of it can rest. */
  terminalDaemonQueryAuthority?: boolean
}
