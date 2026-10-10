import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { isNativeTerminalParseOnceRequested } from '@/lib/pane-manager/native-terminal/native-terminal-requested'
import type { NativeTerminalXtermFeed } from '@/lib/pane-manager/native-terminal/native-terminal-render-pause'
import { setTerminalWebglSuspendedUnderNativeView } from '@/lib/pane-manager/pane-rendering-control'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { xtermShowsLiveOutput } from './foreground-output-scan'
import { scanInputModeSequences } from './terminal-input-mode-sequences'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why delayed: a view that hides again soon (a menu, a dialog) keeps xterm's WebGL context.
const WEBGL_SUSPEND_DELAY_MS = 5_000
const CATCH_UP_POLL_MS = 16
const CATCH_UP_DEADLINE_MS = 3_000
// Bounds the wait for main's reply; a stuck reply leaves the restore to the latch.
const REJOIN_DEADLINE_MS = 1_000

// Parse once: while a native view main feeds covers the pane, main flags the PTY's chunks
// viewFedElsewhere. The pane's observers still run on them, its xterm skips them, and main's
// model (the one parsing) answers their queries. xterm catches up from main's snapshot, as a
// revealed pane does, before it shows again.
export function createNativeTerminalXtermFeed(
  session: ConnectPanePtySession,
  readSettings: () => GlobalSettings | null | undefined
): NativeTerminalXtermFeed {
  let webglTimer: ReturnType<typeof setTimeout> | null = null
  const suspendWebgl = (suspended: boolean): void => {
    if (webglTimer !== null) {
      clearTimeout(webglTimer)
      webglTimer = null
    }
    if (!suspended) {
      setTerminalWebglSuspendedUnderNativeView(session.pane.terminal, false)
      return
    }
    webglTimer = setTimeout(() => {
      webglTimer = null
      if (!session.disposed && session.xtermDetachedForNativeView === true) {
        setTerminalWebglSuspendedUnderNativeView(session.pane.terminal, true)
      }
    }, WEBGL_SUSPEND_DELAY_MS)
  }
  const restorePending = (): boolean =>
    session.hiddenOutputRestoreNeeded === true ||
    session.hiddenOutputRestoreInFlight != null ||
    session.hiddenOutputRestoreScheduled === true

  return {
    detach: () => {
      const ptyId: string | null = session.transport.getPtyId()
      // Only where main's model can answer for the PTY and restore xterm from its snapshot.
      if (
        session.disposed ||
        ptyId === null ||
        !isNativeTerminalParseOnceRequested(readSettings()) ||
        !session.isHiddenDeliveryGateManagedPty(ptyId) ||
        !session.canUseHiddenOutputSnapshot(ptyId)
      ) {
        return false
      }
      session.xtermDetachedForNativeView = true
      void requestViewFedElsewhere(session, true)
      suspendWebgl(true)
      return true
    },
    reattach: async () => {
      suspendWebgl(false)
      if (session.xtermDetachedForNativeView !== true) {
        return
      }
      // Why xterm stays detached until main replies: main replies after the last chunk it
      // flagged, so one restore, started after that, covers every skipped byte.
      await Promise.race([
        requestViewFedElsewhere(session, false),
        new Promise((resolve) => setTimeout(resolve, REJOIN_DEADLINE_MS))
      ])
      session.xtermDetachedForNativeView = false
      // A pane that is hidden anyway restores when it is revealed.
      if (session.disposed || !xtermShowsLiveOutput(session)) {
        return
      }
      if (session.hiddenOutputRestoreNeeded === true) {
        session.markHiddenOutputRestoreNeeded()
      }
      const deadline = Date.now() + CATCH_UP_DEADLINE_MS
      while (!session.disposed && restorePending() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS))
      }
    }
  }
}

// Tells main whether the pane's xterm is off the PTY's byte stream; resolves once main delivers
// by that state. The last state sent lives on the session, so a rebind's old and new feeds agree.
export function requestViewFedElsewhere(
  session: ConnectPanePtySession,
  fedElsewhere: boolean
): Promise<void> {
  const ptyId: string | null = session.transport.getPtyId()
  const sent: { ptyId: string; fedElsewhere: boolean } | null = session.viewFedElsewhereSent ?? null
  if (sent && sent.ptyId !== ptyId && sent.fedElsewhere) {
    void window.api.pty.setRendererPtyViewFedElsewhere(sent.ptyId, false).catch(() => {})
    session.viewFedElsewhereSent = null
  }
  const current = session.viewFedElsewhereSent ?? null
  if (ptyId === null || (current === null && !fedElsewhere)) {
    return Promise.resolve()
  }
  if (current?.ptyId === ptyId && current.fedElsewhere === fedElsewhere) {
    return Promise.resolve()
  }
  session.viewFedElsewhereSent = { ptyId, fedElsewhere }
  return window.api.pty.setRendererPtyViewFedElsewhere(ptyId, fedElsewhere).catch(() => {})
}

// A chunk main flagged viewFedElsewhere: xterm never sees its bytes, so the keyboard-mode mirror
// (which otherwise scans on xterm's write path) reads them here, xterm gets only the sequences
// that change what it sends (paste brackets, key modes), and it latches a restore.
export function skipViewFedElsewhereOutput(session: ConnectPanePtySession, data: string): void {
  session.kittyKeyboardModes.scan(data)
  // Why: main's model parses the stream now, so a query a hidden chunk began completes there.
  session.hiddenStartupRendererQueryPending = ''
  const modes = scanInputModeSequences(data, session.viewFedElsewhereModeTail ?? '')
  session.viewFedElsewhereModeTail = modes.tail
  if (modes.sequences) {
    writeTerminalOutput(session.pane.terminal, modes.sequences, { foreground: true })
  }
  const restoreWasInFlight = session.hiddenOutputRestoreInFlight !== null
  session.markHiddenOutputRestoreNeeded()
  // Why: a chunk flagged before main applied a reattach can land during that restore.
  if (restoreWasInFlight) {
    session.hiddenOutputRestoreFreshSnapshotNeeded = true
  }
}
