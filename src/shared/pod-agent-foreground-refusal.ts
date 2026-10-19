// Fork-only (Pod): the refusal a guarded agent write carries, "agent_not_in_foreground: <reason>",
// on any route: a runtime error, an IPC invoke's rejection, a terminal.send answer.
export const AGENT_NOT_IN_FOREGROUND = 'agent_not_in_foreground'

const REFUSAL = new RegExp(`${AGENT_NOT_IN_FOREGROUND}(?::\\s*([a-z_]+))?`)

/** The refusal's reason when `error` is one (`unknown` when it names none), else null. */
export function readAgentForegroundRefusal(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = REFUSAL.exec(message)
  return match ? (match[1] ?? 'unknown') : null
}
