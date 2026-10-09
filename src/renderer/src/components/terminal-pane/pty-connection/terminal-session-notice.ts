import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { writeNativeTerminalLocal } from '@/lib/pane-manager/native-terminal/native-terminal-mirror'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// A notice about the session itself (not PTY output, and not about xterm's own buffer) belongs
// on every view of the pane: xterm, and a native view that main feeds.
export function writeTerminalSessionNotice(session: ConnectPanePtySession, text: string): void {
  writeTerminalOutput(session.pane.terminal, text, {
    foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
  })
  writeNativeTerminalLocal(session.pane.terminal, text)
}
