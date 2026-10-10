// Fork-only (Pod): what main records for input it didn't write itself; the direct lane's daemon
// queued it on main's stream before the write, ahead of any exit (see writePtyFromRuntimeController).
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import type { OrcaRuntimeService } from '../orca-runtime'
import { podTrace } from '../../../shared/pod-terminal-trace'

type LaneInputRecords = {
  terminalRunFacts: Pick<OrcaRuntimeService['terminalRunFacts'], 'recordInput'>
  observeClaudeTerminalEvidence: OrcaRuntimeService['observeClaudeTerminalEvidence']
}

export function recordPodLaneInput(
  runtime: LaneInputRecords | undefined,
  ptyId: string,
  data: string,
  at: number
): void {
  podTrace('m.lin', data.length)
  runtime?.terminalRunFacts.recordInput(ptyId, 'driving', data, at)
  if (ptyOwnership.get(ptyId) === LOCAL_EXECUTION_HOST_ID) {
    runtime?.observeClaudeTerminalEvidence(ptyId, { kind: 'input', data })
  }
}
