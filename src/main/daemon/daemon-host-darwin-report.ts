import { startSpan } from '../observability/tracer'

export type DaemonHostOutcome =
  | 'reused'
  | 'cloned'
  | 'copied'
  | 'reclaimed'
  | 'bundle'
  | 'ignored'
  | 'kept'
  | 'failed'
  | 'assessed'
  | 'unassessed'

const QUIET: ReadonlySet<DaemonHostOutcome> = new Set(['reused', 'cloned', 'reclaimed', 'assessed'])
const FAILED: ReadonlySet<DaemonHostOutcome> = new Set(['bundle', 'failed'])

// Why a span too: a packaged app's console reaches no file, so the trace log is where a fallback shows.
export function reportDaemonHost(
  outcome: DaemonHostOutcome,
  message: string,
  error?: unknown
): void {
  const line = `[daemon] daemon-host: ${message}`
  const span = startSpan('daemon-host.darwin', { attributes: { outcome, message } })
  if (QUIET.has(outcome)) {
    console.info(line)
  } else if (error === undefined) {
    console.warn(line)
  } else {
    console.warn(line, error)
  }
  if (FAILED.has(outcome)) {
    span.fail(error instanceof Error ? error : message)
  } else {
    span.end()
  }
}
