import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'
import type { CdpSyntheticSessionRegistry } from './cdp-synthetic-session-registry'
import type { CdpDebuggerChannel } from './cdp-debugger-channel'
import type { AgentBrowserSnapshotNarrowing } from './agent-browser-snapshot-narrowing'
import type { AgentBrowserClickMove } from './agent-browser-click-move'

// Fork-only (Pod): what the bridge says about the command agent-browser runs now.
export type AgentBrowserCommandHints = {
  // What the next snapshot prints, so its tree can be cut short.
  snapshotNarrowing?: AgentBrowserSnapshotNarrowing
  // A click in flight, whose pointer move is answered at once.
  clickMove?: AgentBrowserClickMove
}

type ProxiedCommand = { method?: string; params?: Record<string, unknown>; sessionId?: string }

/** The CDP proxy's answers that those hints shape; any other command goes to Chromium as sent. */
export class CdpAgentCommandHints {
  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter,
    private readonly sessions: CdpSyntheticSessionRegistry,
    private readonly debuggerChannel: CdpDebuggerChannel,
    private readonly hints: AgentBrowserCommandHints
  ) {}

  handleCommand(client: WebSocket, clientId: number, msg: ProxiedCommand): boolean {
    const params = msg.params ?? {}
    const narrowing = this.hints.snapshotNarrowing
    if (msg.method === 'Accessibility.getFullAXTree' && narrowing?.narrows(msg.params)) {
      void this.forwardNarrowedAxTree(narrowing, client, clientId, params, msg.sessionId)
      return true
    }
    if (msg.method === 'Input.dispatchMouseEvent' && this.hints.clickMove?.takesMove(params)) {
      this.forwardClickMove(client, clientId, params, msg.sessionId)
      return true
    }
    return false
  }

  private async forwardNarrowedAxTree(
    narrowing: AgentBrowserSnapshotNarrowing,
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): Promise<void> {
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    const sessionId = this.sessions.resolveDebuggerSessionId(msgSessionId)
    try {
      const result = await narrowing.fetch(params, this.webContents.getURL(), (next) =>
        this.debuggerChannel.sendDebuggerCommand('Accessibility.getFullAXTree', next, sessionId)
      )
      this.responder.sendResult(clientId, result, client)
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  private forwardClickMove(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>,
    msgSessionId?: string
  ): void {
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    const sessionId = this.sessions.resolveDebuggerSessionId(msgSessionId)
    try {
      // Why no wait: the press right behind it reports whatever would fail the move too.
      void this.debuggerChannel
        .sendDebuggerCommand('Input.dispatchMouseEvent', params, sessionId)
        .catch(() => {})
      this.responder.sendResult(clientId, {}, client)
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }
}
