import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'

export type PtyDataEvent = {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}

/** Notification-bearing fact a thinning transport detected while it held
 *  scan authority for a backgrounded PTY (see onBackgroundStreamEvent). */
export type PtyTransientFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  | { kind: '2031-subscribe' }
  | { kind: '2031-unsubscribe' }

export type PtyBackgroundStreamEvent =
  | {
      id: string
      kind: 'backgroundMarker'
      background: boolean
      scanSeedAnsi?: string
      mode2031PendingSubscribe?: true
    }
  | { id: string; kind: 'dataGap'; droppedChars: number; sequenceChars?: number }
  /** The daemon answers this PTY's queries in every byte after this event iff `responder`. */
  | { id: string; kind: 'queryResponderMarker'; responder: boolean }
  | { id: string; kind: 'transientFact'; fact: PtyTransientFact }
  // Pod: the direct terminal lane's switch markers and the input it wrote (pod-terminal-lanes.ts).
  | { id: string; kind: 'podLane'; laneId: string; phase: 'attached' | 'detached'; reason?: string }
  | { id: string; kind: 'podLaneInput'; data: string; at: number }
