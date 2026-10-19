// Fork-only (Pod): agent text the classic window writes (a draft paste, its Enter, a follow-up, a
// chat message) asks main to prove the agent holds the terminal first: pty:writeAccepted with
// requireAgentForeground. A local pane proves its foreground group and checks it again right before
// each chunk reaches the provider; an SSH pane asks its relay and refuses a shell it names. A refusal
// rejects the invoke with "agent_not_in_foreground: <reason>", never a quiet false, so the renderer
// doesn't fall back to a plain write of the same bytes.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { IPtyProvider } from '../../providers/types'
import { ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { tryGetProviderForPty } from '../../ipc/pty/provider/registry'
import {
  AGENT_NOT_IN_FOREGROUND,
  assertTerminalForegroundFence,
  proveRelayShellInFront,
  writeIfForegroundSync,
  type TerminalAgentForegroundProof,
  type TerminalForegroundProver
} from './pod-terminal-foreground-fence'

const UNKNOWN: TerminalAgentForegroundProof = { verdict: 'unknown' }

/** The provider as the write path sees it, with each of its writes behind the check. */
function behindCheck(
  provider: IPtyProvider,
  check: ((ptyId: string) => void) | undefined
): IPtyProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (id: string, data: string) =>
          writeIfForegroundSync(check, id, () => target.write(id, data))
      }
      if (property === 'writeWithSettlement') {
        return (id: string, data: string) =>
          writeIfForegroundSync(check, id, () => target.writeWithSettlement(id, data))
      }
      return Reflect.get(target, property, receiver)
    }
  })
}

/**
 * `write` is the IPC handler's own write path (chunking, settlement, observation), handed the
 * provider to write through. An SSH pane without a settled write keeps its route: once its relay
 * names no shell, false, and the renderer writes the bytes as before.
 */
export async function writeAgentForegroundIpcInput(
  args: { id: string; requireWriteSettlement?: true },
  runtime: TerminalForegroundProver | undefined,
  write: (provider: IPtyProvider, verify: boolean) => boolean | Promise<boolean>
): Promise<boolean> {
  const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
  const local = ptyOwnership.get(args.id) === LOCAL_EXECUTION_HOST_ID
  if (!provider || (local && !provider.hasPty?.(args.id))) {
    return false
  }
  const proof = local
    ? ((await runtime?.proveTerminalAgentForegroundFence(args.id, null)) ?? UNKNOWN)
    : await proveRelayShellInFront(provider, args.id)
  if (proof && proof.verdict !== 'agent') {
    throw new Error(`${AGENT_NOT_IN_FOREGROUND}: ${proof.verdict}`)
  }
  const verify = args.requireWriteSettlement === true
  if (!local && !verify) {
    return false
  }
  const fence = proof?.verdict === 'agent' ? proof.fence : null
  let refusal: unknown = null
  const check = fence
    ? (): void => {
        try {
          assertTerminalForegroundFence(fence)
        } catch (error) {
          refusal = error
          throw error
        }
      }
    : undefined
  const accepted = await write(behindCheck(provider, check), verify)
  // The write path turns a throwing write into false; the fence's refusal still rejects.
  if (refusal) {
    throw refusal
  }
  return accepted
}
