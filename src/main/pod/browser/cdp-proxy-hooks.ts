// Fork-only (Pod): where Pod's layers hear the agent CDP proxy (src/main/browser/cdp-ws-proxy.ts):
// each client request with its CDP id, and each reply to it. One-app's panes count a request as an
// agent driving the page; page sleep keeps a page awake from request to reply. A no-op without sinks.

export type PodCdpProxySink = {
  request?: (webContentsId: number, clientId: number) => void
  reply?: (webContentsId: number, clientId: number) => void
}

const sinks = new Set<PodCdpProxySink>()

/** Registers a sink; returns its removal. */
export function addPodCdpProxySink(sink: PodCdpProxySink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

export function podCdpProxyRequest(webContentsId: number, clientId: number): void {
  for (const sink of sinks) {
    sink.request?.(webContentsId, clientId)
  }
}

export function podCdpProxyReply(webContentsId: number, clientId: number): void {
  for (const sink of sinks) {
    sink.reply?.(webContentsId, clientId)
  }
}
