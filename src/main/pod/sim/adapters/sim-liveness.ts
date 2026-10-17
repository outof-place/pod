// Fork-only (Pod): what this runtime can see of a lease's holder, for the core's liveness rule
// (sim-holder-liveness.ts). An agent or a process is its pid plus start, the same from any runtime.
// An agent session and a terminal pane are Pod's own: only the runtime that resolved the holder
// (or its restart) may look, in its agent-status store and its panes, and until those are wired
// and loaded the answer is "still warming", which keeps the lease. Outside use is claude-acc's
// watcher rule (devguard_core.py discover_simulators): a process outside every simulator whose
// argv names a Pod device, unless it is one of Pod's own tool calls (simctl or simslim naming
// Pod's set, the pod-sim helper) or runs under one. Agents' runs count wherever they run: the
// terminal daemon and every agent shell under it stay children of the runtime that started them.
import { SIM_HOLDER_START_TOLERANCE_S } from '../leases/sim-holder-liveness'
import type { SimLivenessPort } from '../pool/sim-pool-ports'
import { SIM_HELPER_FILE_NAME } from '../helper/sim-helper-path'
import {
  processSubtrees,
  simulatorProcesses,
  udidsIn,
  type SimProcessFacts,
  type SimProcessRow
} from './sim-process-facts'

/**
 * The panes and agent sessions of this runtime (stage 7 wires them: sessions through
 * simSessionFromStatusRows over the hook server's rows, terminals through the runtime's handles).
 */
export type SimPodPanes = Readonly<{
  session(sessionId: string): 'storeWarming' | 'unseen' | 'present' | 'ended'
  terminal(handle: string): 'storeWarming' | 'open' | 'closed'
}>

/** The fields of the hook server's status rows (AgentStatusIpcPayload) a session's end shows in. */
export type SimStatusRow = Readonly<{
  providerSession?: Readonly<{ id: string }>
  agentPresence?: Readonly<{ ended?: boolean }>
  providerSessionOnly?: boolean
  restoredUnconfirmed?: boolean
}>

/**
 * An agent session in Pod's agent-status store. `ready`: the store has loaded what it persisted
 * (hydration). A row restored but not yet confirmed by its agent is still warming; an agent that
 * exited leaves an ended presence or a resume-only remnant. No row at all is `unseen`: a pane
 * closing, a pruned store or a session it never heard of are all absence, not an end.
 */
export function simSessionFromStatusRows(
  rows: readonly SimStatusRow[],
  sessionId: string,
  ready: boolean
): 'storeWarming' | 'unseen' | 'present' | 'ended' {
  if (!ready) {
    return 'storeWarming'
  }
  const row = rows.find((candidate) => candidate.providerSession?.id === sessionId)
  if (!row) {
    return 'unseen'
  }
  if (row.agentPresence?.ended || row.providerSessionOnly) {
    return 'ended'
  }
  return row.restoredUnconfirmed ? 'storeWarming' : 'present'
}

export type SimLivenessOptions = Readonly<{
  // Pod's device set: the `--set` its own simctl and simslim calls name.
  deviceSet: string
  processes: SimProcessFacts
  panes: SimPodPanes | null
  // null: the set could not be read.
  podDevices: () => Promise<ReadonlySet<string> | null>
}>

const HELPER = new RegExp(`(^|/)${SIM_HELPER_FILE_NAME}(\\s|$)`)

/** Pod's own tool calls and everything they started: simctl or simslim on its set, the helper. */
function podToolCalls(rows: readonly SimProcessRow[], deviceSet: string): Set<number> {
  const setArgument = `--set ${deviceSet} `
  const roots = rows
    .filter((row) => HELPER.test(row.command) || `${row.command} `.includes(setArgument))
    .map((row) => row.pid)
  return processSubtrees(rows, roots)
}

export function createSimLiveness(options: SimLivenessOptions): SimLivenessPort {
  const { processes, panes } = options
  return {
    async holderFacts(holder, resolvedHere) {
      const process = holder.pid === undefined ? 'unknown' : await processes.startOf(holder.pid)
      if (!resolvedHere) {
        return { process, session: 'notServedHere', terminal: 'notServedHere' }
      }
      return {
        process,
        session: holder.sessionId && panes ? panes.session(holder.sessionId) : 'storeWarming',
        terminal:
          holder.terminalHandle && panes ? panes.terminal(holder.terminalHandle) : 'storeWarming'
      }
    },

    async runtime(ref) {
      const start = await processes.startOf(ref.pid)
      if (start === 'unknown') {
        return 'live'
      }
      return start.found &&
        Math.abs(start.startedAt - ref.startedAt) <= SIM_HOLDER_START_TOLERANCE_S
        ? 'live'
        : 'exited'
    },

    async externalUse() {
      const [rows, pod] = await Promise.all([processes.table(), options.podDevices()])
      if (!rows || !pod || pod.size === 0) {
        return []
      }
      const inside = simulatorProcesses(rows)
      const ours = podToolCalls(rows, options.deviceSet)
      const used = new Set<string>()
      for (const row of rows) {
        if (inside.has(row.pid) || ours.has(row.pid)) {
          continue
        }
        for (const udid of udidsIn(row.command)) {
          if (pod.has(udid)) {
            used.add(udid)
          }
        }
      }
      return [...used].sort()
    }
  }
}
