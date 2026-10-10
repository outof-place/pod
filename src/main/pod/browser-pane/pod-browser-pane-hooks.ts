// Fork-only (Pod): what upstream modules call into one-app's browser panes. Dependency-free, so the
// runtime and the agent bridge import nothing of the panes themselves.
type AgentCommandSink = (webContentsId: number) => void

/** A download of a page no renderer hosts, as the browser manager would have told the renderer. */
export type PodBrowserDownloadEvent =
  | {
      kind: 'requested'
      browserPageId: string
      downloadId: string
      filename: string
      totalBytes: number | null
      savePath: string
    }
  | {
      kind: 'progress'
      browserPageId: string
      downloadId: string
      receivedBytes: number
      totalBytes: number | null
      state: 'progressing' | 'interrupted' | null
    }
  | {
      kind: 'finished'
      browserPageId: string
      downloadId: string
      status: 'completed' | 'canceled' | 'failed'
      savePath: string | null
      error: string | null
    }

let agentCommandSink: AgentCommandSink | null = null
let downloadSink: ((event: PodBrowserDownloadEvent) => void) | null = null

export function setPodBrowserPaneHooks(
  hooks: {
    agentCommand: AgentCommandSink
    download: (event: PodBrowserDownloadEvent) => void
  } | null
): void {
  agentCommandSink = hooks?.agentCommand ?? null
  downloadSink = hooks?.download ?? null
}

/** True once one-app's panes own browser pages: browser commands then take the offscreen path. */
export function podBrowserPanesHostBrowserTabs(): boolean {
  return agentCommandSink !== null
}

/** A download the browser manager had no renderer for; a no-op outside one-app. */
export function forwardPodBrowserDownload(event: PodBrowserDownloadEvent): void {
  downloadSink?.(event)
}

/** An agent's command reached `webContentsId`; a no-op outside one-app. */
export function notePodAgentBrowserCommand(webContentsId: number): void {
  agentCommandSink?.(webContentsId)
}
