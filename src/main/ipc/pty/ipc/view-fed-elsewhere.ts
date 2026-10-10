import { requestRendererPtyViewFedElsewhere } from '../../pty-hidden-delivery-gate'
import { getPtyIpc } from '../../pty-host-bindings'
import type { PtyIpcSession } from '../session'

// Parse once: a pane whose native view main feeds asks main to stop having its xterm parse the
// PTY's bytes (or to start again). Main applies it at the next delivery-batch boundary and
// replies then, after the last chunk it flagged by the old state.
export function installRendererPtyViewFedElsewhereIpc(session: PtyIpcSession): void {
  const ipcMain = getPtyIpc()
  ipcMain.removeHandler('pty:setRendererPtyViewFedElsewhere')
  ipcMain.handle(
    'pty:setRendererPtyViewFedElsewhere',
    async (_event, args: { id: string; fedElsewhere: boolean }): Promise<void> => {
      if (typeof args?.id !== 'string' || !args.id) {
        return
      }
      await requestRendererPtyViewFedElsewhere(
        args.id,
        args.fedElsewhere === true,
        session.pendingData.get(args.id) === undefined
      )
    }
  )
}
