// Fork-only (Pod): a renderer write marked `requireAgentForeground` (an agent paste, its Enter, a
// follow-up) lands only while an agent's foreground process group holds the pane's terminal: found
// with a fresh read, then read again in the write's own synchronous block. A refusal rejects the
// invoke, so the renderer never falls back to its unacknowledged write. A pane the check can't read
// (SSH, Windows) writes as before.
import {
  createForegroundGroupWriteGate,
  type ForegroundGroupHost
} from '../../../runtime/pod-foreground-group-write-gate'

export async function writeWhileAgentInFront(
  host: ForegroundGroupHost | undefined,
  ptyId: string,
  write: () => boolean | Promise<boolean>
): Promise<boolean> {
  const gate = createForegroundGroupWriteGate(host ?? {}, null)
  const verdict = await gate.prove(ptyId)
  if (verdict === 'shell' || verdict === 'unknown' || !gate.holds(ptyId)) {
    throw new Error('agent_not_in_foreground')
  }
  return await write()
}
