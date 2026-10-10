// Fork-only (Pod): what upstream modules call into one-app's browser panes. Dependency-free, so the
// runtime and the agent bridge import nothing of the panes themselves.
type AgentCommandSink = (webContentsId: number) => void

let agentCommandSink: AgentCommandSink | null = null

export function setPodBrowserPaneHooks(sink: AgentCommandSink | null): void {
  agentCommandSink = sink
}

/** True once one-app's panes own browser pages: browser commands then take the offscreen path. */
export function podBrowserPanesHostBrowserTabs(): boolean {
  return agentCommandSink !== null
}

/** An agent's command reached `webContentsId`; a no-op outside one-app. */
export function notePodAgentBrowserCommand(webContentsId: number): void {
  agentCommandSink?.(webContentsId)
}
