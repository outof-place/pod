// Fork-only (Pod): the hook server's word that a claude started or ended (a row's process identity
// changed), for the deferred settings.json cut (pod-claude-settings-cut.ts). No imports: the hook
// server stays free of the cut's dependencies.
type PresenceRow = {
  agentPresence?: {
    agent?: string
    process?: { pid?: number; startTime?: string }
    ended?: boolean
  }
} | null

let listener: (() => void) | null = null

export function setPodClaudeAgentChangeListener(next: (() => void) | null): void {
  listener = next
}

function presenceKey(row: PresenceRow | undefined): string {
  const presence = row?.agentPresence
  if (presence?.agent !== 'claude' || !presence.process) {
    return ''
  }
  return `${presence.process.pid}:${presence.process.startTime}:${presence.ended === true}`
}

export function notePodClaudeAgentChange(
  before: PresenceRow | undefined,
  after: PresenceRow | undefined
): void {
  if (listener && presenceKey(before) !== presenceKey(after)) {
    listener()
  }
}
