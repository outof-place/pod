// Fork-only (Pod): upstream errors that never pass translateMain() are branded where they leave
// the main process, so hundreds of literal throw sites stay upstream's: IPC handler rejections
// here, RPC errors in errorResponse(), CLI errors in reportCliError(). Logs and ids never pass.
// Copy that names Orca on purpose (the legacy import) must not travel as one of these errors.
import { ipcMain, type IpcMain } from 'electron'
import { brandProductCopy, getProductNameBranding } from './product-overlay'

/** The thrown value with its message branded; the same Error, so code and data survive. */
export function brandErrorCopy(error: unknown): unknown {
  if (typeof error === 'string') {
    return brandProductCopy(error)
  }
  if (error instanceof Error) {
    const branded = brandProductCopy(error.message)
    if (branded !== error.message) {
      error.message = branded
    }
  }
  return error
}

type IpcRegistrar = Pick<IpcMain, 'handle' | 'handleOnce'>

/** Rejections from every `ipcMain.handle` listener reach the renderer branded. */
export function brandIpcHandlerErrors(ipc: IpcRegistrar): void {
  if (!getProductNameBranding()) {
    return
  }
  const wrap =
    (register: IpcRegistrar['handle']): IpcRegistrar['handle'] =>
    (channel, listener) =>
      register(channel, async (event, ...args) => {
        try {
          return await listener(event, ...args)
        } catch (error) {
          throw brandErrorCopy(error)
        }
      })
  ipc.handle = wrap(ipc.handle.bind(ipc))
  ipc.handleOnce = wrap(ipc.handleOnce.bind(ipc))
}

/** Pre-ready, before any handler registers; a no-op without a product identity. */
export function installProductCopyBoundaries(): void {
  if (getProductNameBranding()) {
    brandIpcHandlerErrors(ipcMain)
  }
}
