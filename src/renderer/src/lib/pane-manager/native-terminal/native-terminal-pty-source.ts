import type { NativeTerminalMirror } from './native-terminal-mirror'
import type { NativeTerminalPaneHost } from './native-terminal-pane-state'
import type { NativeTerminalRenderPause } from './native-terminal-render-pause'

type NativeTerminalSourcePane = {
  surfaceId: number | null
  ptyId: string
  disposed: boolean
  host: Pick<NativeTerminalPaneHost, 'serialize' | 'xtermFeed'>
  renderPause: Pick<NativeTerminalRenderPause, 'setFeed'> | null
}

// Main feeds a surface straight from the PTY stream when its bytes pass through main; the
// renderer mirror is the fallback (paired remote runtimes, or main declining).
export async function connectNativeTerminalSource(
  api: Window['api']['nativeTerminal'],
  pane: NativeTerminalSourcePane,
  mirror: NativeTerminalMirror,
  reset: boolean
): Promise<void> {
  const { surfaceId, ptyId } = pane
  if (surfaceId === null) {
    return
  }
  // Why first: while main answers, forwarding from here could duplicate bytes main sends too.
  mirror.followMain(surfaceId)
  const fedByMain = await api.bindPty(surfaceId, ptyId).catch(() => false)
  if (pane.disposed || pane.surfaceId !== surfaceId || pane.ptyId !== ptyId) {
    return
  }
  // Parse once only where main feeds the view; a mirrored view needs xterm's bytes.
  pane.renderPause?.setFeed(fedByMain ? (pane.host.xtermFeed ?? null) : null)
  if (fedByMain) {
    return
  }
  // The renderer seed covers everything the mirror skipped while main answered.
  mirror.attach(surfaceId, () => pane.host.serialize(), reset)
}
