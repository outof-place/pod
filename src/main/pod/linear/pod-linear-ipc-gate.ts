// Fork-only (Pod): the classic window's linear:* IPC answers like linear.* RPC while Linear is off.
// Every channel but linear:status throws linear_unavailable before its handler reads the store or
// the network. The token is the whole message, as IPC drops the code and the renderer matches it
// at the end of "Error invoking remote method …: Error: <code>" (hasRuntimeRpcErrorCode).
import type { IpcMain } from 'electron'
import { podLinearAvailability } from './pod-linear-availability'

export const POD_LINEAR_UNAVAILABLE_CODE = 'linear_unavailable'

// The status says why Linear is off and reads nothing while it is (client.ts getStatus).
const POD_LINEAR_IPC_ALWAYS_ANSWERS: ReadonlySet<string> = new Set(['linear:status'])

type IpcHandler = Parameters<IpcMain['handle']>[1]

export function podLinearUnavailableIpcError(): Error {
  return Object.assign(new Error(POD_LINEAR_UNAVAILABLE_CODE), {
    code: POD_LINEAR_UNAVAILABLE_CODE
  })
}

export function gatePodLinearIpcHandler(channel: string, handler: IpcHandler): IpcHandler {
  if (!channel.startsWith('linear:') || POD_LINEAR_IPC_ALWAYS_ANSWERS.has(channel)) {
    return handler
  }
  return (event, ...args) => {
    if (!podLinearAvailability().available) {
      throw podLinearUnavailableIpcError()
    }
    return handler(event, ...args)
  }
}

/** Runs `register` with every linear:* handler it registers on `ipc` gated; one place for all. */
export function registerWithPodLinearIpcGate(
  ipc: Pick<IpcMain, 'handle'>,
  register: () => void
): void {
  const handle = ipc.handle
  ipc.handle = (channel, handler) =>
    handle.call(ipc, channel, gatePodLinearIpcHandler(channel, handler))
  try {
    register()
  } finally {
    ipc.handle = handle
  }
}
