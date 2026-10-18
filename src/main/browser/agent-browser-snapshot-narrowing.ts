import {
  axTreeCoversSnapshotDepth,
  type AxTreeNode,
  type SnapshotDepthOptions
} from './agent-browser-snapshot-depth'

// A cut this large that still falls short costs more than the rest of the tree: fetch it all.
const CUT_NODE_LIMIT = 5_000
const MAX_CUT_DEPTH = 64
const REMEMBERED_CUTS_LIMIT = 64

type AxTreeReply = { nodes: AxTreeNode[] }

function isAxTreeReply(reply: unknown): reply is AxTreeReply {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    'nodes' in reply &&
    Array.isArray(reply.nodes)
  )
}

/**
 * Answers the getFullAXTree of a `snapshot --depth N` with the shallowest cut of the tree that prints
 * the same lines: Chromium's cost is per node, and a heavy page's lines at depth 2 lie a few levels
 * down. The bridge says which snapshot comes; any other getFullAXTree (a ref lookup) gets it all.
 */
export class AgentBrowserSnapshotNarrowing {
  private expected: SnapshotDepthOptions | null = null
  // The cut that answered last time, per page and options; null when only the whole tree did.
  private readonly answeredCuts = new Map<string, number | null>()

  expect(options: SnapshotDepthOptions | null): void {
    this.expected = options
  }

  narrows(params: Record<string, unknown> | undefined): boolean {
    return this.expected !== null && params?.depth === undefined
  }

  async fetch(
    params: Record<string, unknown>,
    pageKey: string,
    send: (params: Record<string, unknown>) => Promise<unknown>
  ): Promise<unknown> {
    const options = this.expected
    if (!options) {
      return send(params)
    }
    const frame = typeof params.frameId === 'string' ? params.frameId : ''
    const key = `${options.depth}|${options.interactive}|${frame}|${pageKey}`
    const remembered = this.answeredCuts.get(key)
    if (remembered === null) {
      return send(params)
    }
    let cut = remembered ?? options.depth + 3
    let previousCount = -1
    while (cut <= MAX_CUT_DEPTH) {
      const reply = await send({ ...params, depth: cut })
      if (!isAxTreeReply(reply)) {
        return reply
      }
      if (axTreeCoversSnapshotDepth(reply.nodes, options)) {
        this.remember(key, cut)
        return reply
      }
      // A cut that stopped growing will not cover by going deeper.
      if (reply.nodes.length >= CUT_NODE_LIMIT || reply.nodes.length === previousCount) {
        break
      }
      previousCount = reply.nodes.length
      cut += 1
    }
    this.remember(key, null)
    return send(params)
  }

  private remember(key: string, cut: number | null): void {
    if (this.answeredCuts.size >= REMEMBERED_CUTS_LIMIT && !this.answeredCuts.has(key)) {
      this.answeredCuts.clear()
    }
    this.answeredCuts.set(key, cut)
  }
}
