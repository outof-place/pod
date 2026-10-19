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

function refusal(reason: string): Error {
  return new Error(`${AGENT_NOT_IN_FOREGROUND}: ${reason}`)
}

/** A payload's guard flag is absent or exactly true; anything else would quietly turn it off. */
export function hasValidAgentForegroundFlag(payload: object): boolean {
  const flag: unknown = Reflect.get(payload, 'requireAgentForeground')
  return flag === undefined || flag === true
}

/**
 * A write the IPC path didn't take (the mobile lock, a viewport claim that failed): false for an
 * unguarded write, as upstream answers, but a refusal for a guarded one, so the renderer can't fall
 * back to a plain write of agent text.
 */
export function notTakenWrite(
  args: { requireAgentForeground?: true },
  reason: string
): false | Promise<never> {
  return args.requireAgentForeground === true ? Promise.reject(refusal(reason)) : false
}

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
  // A local pane never answers false: the renderer falls back to a plain write on false.
  if (local && !provider?.hasPty?.(args.id)) {
    throw refusal('no_pty')
  }
  if (!provider) {
    return false
  }
  const proof = local
    ? ((await runtime?.proveTerminalAgentForegroundFence(args.id, null)) ?? UNKNOWN)
    : await proveRelayShellInFront(provider, args.id)
  if (proof && proof.verdict !== 'agent') {
    throw refusal(proof.verdict)
  }
  const verify = args.requireWriteSettlement === true
  if (!local && !verify) {
    return false
  }
  const fence = proof?.verdict === 'agent' ? proof.fence : null
  let fenceRefusal: unknown = null
  const check = fence
    ? (): void => {
        try {
          assertTerminalForegroundFence(fence)
        } catch (error) {
          fenceRefusal = error
          throw error
        }
      }
    : undefined
  const accepted = await write(behindCheck(provider, check), verify)
  // The write path turns a throwing write into false; the fence's refusal still rejects.
  if (fenceRefusal) {
    throw fenceRefusal
  }
  // Too large, a provider that took nothing, an unavailable PTY: on a local pane, a refusal too.
  if (!accepted && local) {
    throw refusal('write_not_accepted')
  }
  return accepted
}
