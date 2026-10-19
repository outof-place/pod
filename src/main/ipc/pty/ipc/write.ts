import type { PtyRendererDelivery } from '../session'
import { getPtyIpc } from '../../pty-host-bindings'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { createPtyWriteInput } from './write-input'
import { notTakenWrite } from '../../../pod/terminal/pod-agent-foreground-ipc-write'
import { noteRendererPtyInput, noteRendererViewportClaim } from '../renderer-query-responder'

export function installPtyWriteIpcHandlers(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): void {
  const ipcMain = getPtyIpc()
  const { runtime } = deps
  const {
    writePtyInput,
    writePtyInputAccepted,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  } = createPtyWriteInput(deps)

  const hostViewportClaimTails = new Map<string, Promise<boolean>>()

  ipcMain.on('pty:write', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return
    }
    noteRendererPtyInput(args.id, args.data)
    const claimTail = hostViewportClaimTails.get(args.id)
    if (claimTail) {
      void claimTail.then((claimed) => (claimed ? writePtyInput(args) : false))
      return
    }
    writePtyInput(args)
  })
  ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return false
    }
    // Fork-only (Pod): before a guarded write's proof too; it marks the window driving the pane.
    noteRendererPtyInput(args.id, args.data)
    const claimTail = hostViewportClaimTails.get(args.id)
    // Fork-only (Pod): a guarded write the failed claim discards is refused, not answered false.
    return claimTail
      ? claimTail.then((claimed) =>
          claimed ? writePtyInputAccepted(args) : notTakenWrite(args, 'viewport_claim_failed')
        )
      : writePtyInputAccepted(args)
  })

  ipcMain.removeAllListeners('pty:claimViewport')
  ipcMain.on('pty:claimViewport', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !runtime || !isPtyViewportClaimPayload(args)) {
      return
    }
    noteRendererViewportClaim(args.id)
    const prior = hostViewportClaimTails.get(args.id)
    // Why: two panes can mirror one PTY — never let a later no-op claim replace the in-flight resize that the following host input must await.
    const claim = (
      prior
        ? prior.then(
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows),
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
          )
        : runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
    ).catch((error) => {
      // Why: a failed claim silently discards every gated keystroke for this pane.
      console.error('[pty] remote desktop host claim failed; gated input will be discarded', error)
      return false
    })
    hostViewportClaimTails.set(args.id, claim)
    void claim.then(() => {
      if (hostViewportClaimTails.get(args.id) === claim) {
        hostViewportClaimTails.delete(args.id)
      }
    })
  })
}
