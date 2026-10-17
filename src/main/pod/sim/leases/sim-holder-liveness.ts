// Fork-only (Pod): whether a lease's holder still lives, from what one runtime can see of it. Only
// positive evidence of an end reads `exited`; anything this runtime cannot see (another runtime's
// panes and sessions, a status store still loading after a restart, a failed lookup) reads
// `unverifiable`, and the pool keeps the lease (loss of contact is never death).
import type { SimHolder, SimHolderLiveness } from '../../../../shared/pod-sim/sim-holder'

/** claude-acc's tolerance between a lease file's start and the process's (devguard lease_alive). */
export const SIM_HOLDER_START_TOLERANCE_S = 2

/** What one runtime knows about a holder; the adapter (stage 4b) gathers it. */
export type SimHolderFacts = Readonly<{
  // The process at the holder's pid: its start in epoch seconds, or none (a zombie is none).
  process: { found: true; startedAt: number } | { found: false } | 'unknown'
  // This runtime's agent-status store for the holder's session (`unseen`: no row, which is no
  // evidence of an end), and its panes for the handle.
  session: 'notServedHere' | 'storeWarming' | 'unseen' | 'present' | 'ended'
  terminal: 'notServedHere' | 'storeWarming' | 'open' | 'closed'
}>

function byProcess(holder: SimHolder, process: SimHolderFacts['process']): SimHolderLiveness {
  if (process === 'unknown') {
    return 'unverifiable'
  }
  if (!process.found || holder.startedAt === undefined) {
    return 'exited'
  }
  const drift = Math.abs(process.startedAt - holder.startedAt)
  return drift <= SIM_HOLDER_START_TOLERANCE_S ? 'live' : 'exited'
}

export function simHolderLiveness(holder: SimHolder, facts: SimHolderFacts): SimHolderLiveness {
  switch (holder.kind) {
    case 'agent':
    case 'process':
      return byProcess(holder, facts.process)
    case 'agentSession':
      return facts.session === 'present'
        ? 'live'
        : facts.session === 'ended'
          ? 'exited'
          : 'unverifiable'
    case 'terminal':
      return facts.terminal === 'open'
        ? 'live'
        : facts.terminal === 'closed'
          ? 'exited'
          : 'unverifiable'
    case 'human':
      return 'live'
  }
}
