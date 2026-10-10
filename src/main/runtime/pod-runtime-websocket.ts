// Fork-only (Pod): whether the runtime RPC opens its WebSocket listener (src/shared/product/features.ts).
import { POD_RUNTIME_WEBSOCKET } from '../../shared/product/features'
import { isPodHeadlessHost } from '../pod/headless-host/headless-host-mode'
import { WS_BIND_HOST_LOOPBACK } from './runtime-rpc/runtime-rpc-pairing-types'

// Why the re-export: the launch file sits at max-lines, so it imports the server and this gate
// through one line; tests that mock ./runtime-rpc still replace the server here.
export { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why: the listener binds every interface once any network-paired device was ever seen, and an
// imported Orca profile brings its paired phones along; Pod has no pairing UI to revoke them.
export function runtimeWebSocketEnabled(options: { serveMode: boolean }): boolean {
  // Why first, with no switch: PodNative reaches its headless host over the unix socket, and the
  // host must have no listener beyond it.
  if (isPodHeadlessHost()) {
    return false
  }
  return POD_RUNTIME_WEBSOCKET || options.serveMode
}

/** The runtime RPC server's WebSocket options for this launch. */
export function podRuntimeWebSocketOptions(options: { serveMode: boolean }): {
  enableWebSocket: boolean
  pinnedBindHost?: string
} {
  const enableWebSocket = runtimeWebSocketEnabled(options)
  // Why a loopback pin even for explicit serve: nothing in Pod shows or revokes a paired device,
  // and a pin also outranks the widen a once-seen device triggers at every later start.
  return POD_RUNTIME_WEBSOCKET
    ? { enableWebSocket }
    : { enableWebSocket, pinnedBindHost: WS_BIND_HOST_LOOPBACK }
}
