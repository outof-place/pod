// The desktop window's xterm as one view in the PTY's query-responder election: it stands while
// it shows the PTY, and it answers queries only while elected (terminal-query-responder-election.ts).
import { extractOnlyTerminalQueryReplies } from '../../../shared/terminal-query-reply'
import {
  attachTerminalQueryResponderCandidate,
  isTerminalQueryResponder,
  noteTerminalQueryResponderClaim,
  noteTerminalQueryResponderKeyboard,
  setTerminalQueryResponderChangeListener
} from '../../runtime/terminal-query-responder-election'

export const RENDERER_QUERY_RESPONDER_KEY = 'renderer'

const releases = new Map<string, () => void>()
// Last state sent per PTY; the renderer answers unless told otherwise.
const sentAnswers = new Map<string, boolean>()
let sendToRenderer: ((ptyId: string, answers: boolean) => void) | null = null

export function installRendererQueryResponder(
  send: (ptyId: string, answers: boolean) => void
): void {
  sendToRenderer = send
  setTerminalQueryResponderChangeListener(syncRendererQueryResponder)
}

function syncRendererQueryResponder(ptyId: string): void {
  if (!releases.has(ptyId) && !sentAnswers.has(ptyId)) {
    return
  }
  const answers =
    !releases.has(ptyId) || isTerminalQueryResponder(ptyId, RENDERER_QUERY_RESPONDER_KEY)
  if ((sentAnswers.get(ptyId) ?? true) === answers) {
    return
  }
  if (answers) {
    sentAnswers.delete(ptyId)
  } else {
    sentAnswers.set(ptyId, answers)
  }
  sendToRenderer?.(ptyId, answers)
}

/** The window shows (or stops showing) this PTY. */
export function setRendererQueryResponderVisible(ptyId: string, visible: boolean): void {
  if (visible && !releases.has(ptyId)) {
    releases.set(
      ptyId,
      attachTerminalQueryResponderCandidate(ptyId, RENDERER_QUERY_RESPONDER_KEY, 'renderer')
    )
    syncRendererQueryResponder(ptyId)
  } else if (!visible) {
    const release = releases.get(ptyId)
    releases.delete(ptyId)
    release?.()
    syncRendererQueryResponder(ptyId)
  }
}

/** Input the window wrote: its own replies are not the user. */
export function noteRendererPtyInput(ptyId: string, data: string): void {
  if (releases.has(ptyId) && !extractOnlyTerminalQueryReplies(data)) {
    noteTerminalQueryResponderKeyboard(ptyId, RENDERER_QUERY_RESPONDER_KEY)
  }
}

export function noteRendererViewportClaim(ptyId: string): void {
  if (releases.has(ptyId)) {
    noteTerminalQueryResponderClaim(ptyId, RENDERER_QUERY_RESPONDER_KEY)
  }
}

/** Tells the window whether it answers this PTY's queries (it does unless told otherwise). */
export function sendRendererQueryResponder(
  session: {
    mainWindow?: {
      isDestroyed: () => boolean
      webContents: { send: (channel: string, payload: unknown) => void }
    } | null
  },
  ptyId: string,
  answers: boolean
): void {
  const window = session.mainWindow
  if (window && !window.isDestroyed()) {
    window.webContents.send('pty:queryResponder', { id: ptyId, answers })
  }
}

export function _resetRendererQueryResponderForTest(): void {
  for (const release of releases.values()) {
    release()
  }
  releases.clear()
  sentAnswers.clear()
  sendToRenderer = null
}
