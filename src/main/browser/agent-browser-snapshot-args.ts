import type { BrowserSnapshotOptions } from '../../shared/runtime-types'

/** The snapshot options inside RPC params, each kept only when agent-browser accepts it. */
export function browserSnapshotOptions(params: {
  interactive?: unknown
  compact?: unknown
  depth?: unknown
  selector?: unknown
}): BrowserSnapshotOptions {
  return {
    interactive: params.interactive === true,
    compact: params.compact === true,
    depth: isSnapshotDepth(params.depth) ? params.depth : undefined,
    selector: typeof params.selector === 'string' ? params.selector : undefined
  }
}

// Why: the RPC number primitive also admits 0 and fractions, which agent-browser's -d rejects.
function isSnapshotDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** The depth agent-browser's -d receives for these options, if any. */
export function agentBrowserSnapshotDepth(options: BrowserSnapshotOptions = {}): number | undefined {
  return isSnapshotDepth(options.depth) ? options.depth : undefined
}

/** agent-browser's `snapshot` argv for these options (its -i, -c, -d and -s). */
export function agentBrowserSnapshotArgs(options: BrowserSnapshotOptions = {}): string[] {
  const args = ['snapshot']
  if (options.interactive) {
    args.push('-i')
  }
  if (options.compact) {
    args.push('-c')
  }
  if (isSnapshotDepth(options.depth)) {
    args.push('-d', String(options.depth))
  }
  if (options.selector) {
    args.push('-s', options.selector)
  }
  return args
}
