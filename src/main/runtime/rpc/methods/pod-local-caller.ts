// Fork-only (Pod): RPC twins of IPC that only this machine's own window could call.
import type { RpcContext } from '../core'

/**
 * Refuses paired devices (`forbidden`, which passes through to the client): what the desktop's
 * own settings did stays on this machine, for this machine's PodNative and owner-token CLI.
 *
 * Not a guard against an SSH host's orca CLI: its calls also carry the `local-cli` identity, so
 * only the method's permission keeps it out. Every method using this check declares `host-admin`.
 */
export function assertLocalRpcCaller(ctx: Pick<RpcContext, 'caller'>, method: string): void {
  const kind = ctx.caller?.kind
  if (kind === 'local-cli' || kind === 'desktop') {
    return
  }
  throw Object.assign(new Error(`${method} is available only on this machine.`), {
    code: 'forbidden'
  })
}
