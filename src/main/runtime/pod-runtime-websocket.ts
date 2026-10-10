// Fork-only (Pod): whether the runtime RPC opens its WebSocket listener (src/shared/product/features.ts).
import { POD_RUNTIME_WEBSOCKET } from '../../shared/product/features'

// Why the re-export: the launch file sits at max-lines, so it imports the server and this gate
// through one line; tests that mock ./runtime-rpc still replace the server here.
export { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why: the listener binds every interface once any network-paired device was ever seen, and an
// imported Orca profile brings its paired phones along; Pod has no pairing UI to revoke them.
export function runtimeWebSocketEnabled(options: { serveMode: boolean }): boolean {
  return POD_RUNTIME_WEBSOCKET || options.serveMode
}
