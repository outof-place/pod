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

/** A new-tab open of an offscreen page; true once PodNative has it. */
type LinkOpenSink = (browserPageId: string, url: string, activate: boolean) => boolean

/** A security key's accounts for a page: PodNative's pick, or null when no pane shows the page. */
type PasskeySink = (
  webContentsId: number,
  relyingPartyId: string,
  accounts: readonly { credentialId: string; displayName?: string; name?: string }[]
) => Promise<string | null> | null

let agentCommandSink: AgentCommandSink | null = null
let downloadSink: ((event: PodBrowserDownloadEvent) => void) | null = null
let linkOpenSink: LinkOpenSink | null = null
let passkeySink: PasskeySink | null = null

export function setPodBrowserPaneHooks(
  hooks: {
    agentCommand: AgentCommandSink
    download: (event: PodBrowserDownloadEvent) => void
    openLink: LinkOpenSink
    passkey: PasskeySink
  } | null
): void {
  agentCommandSink = hooks?.agentCommand ?? null
  downloadSink = hooks?.download ?? null
  linkOpenSink = hooks?.openLink ?? null
  passkeySink = hooks?.passkey ?? null
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

/** A link a page opens in a new tab while no renderer hosts it; false outside one-app. */
export function openPodPaneLink(browserPageId: string, url: string, activate: boolean): boolean {
  return linkOpenSink?.(browserPageId, url, activate) ?? false
}

/** A security key's account pick for a page no renderer hosts; null outside one-app or with no pane. */
export function pickPodPanePasskey(
  ...args: Parameters<PasskeySink>
): Promise<string | null> | null {
  return passkeySink?.(...args) ?? null
}
