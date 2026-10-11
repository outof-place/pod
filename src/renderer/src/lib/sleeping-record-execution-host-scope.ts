import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { agentResumeOriginNamesAnotherExecutionHost } from '../../../shared/agent-resume-origin-host'
import {
  getKnownExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

export { agentResumeOriginNamesAnotherExecutionHost }

/** The worktree-scoped form the activation sweep asks, resolving the host from the catalog. */
export function sleepingRecordNamesAnotherExecutionHost(
  record: SleepingAgentSessionRecord,
  state: WorktreeRuntimeOwnerState
): boolean {
  return agentResumeOriginNamesAnotherExecutionHost(
    record.connectionId,
    getKnownExecutionHostIdForWorktree(state, record.worktreeId)
  )
}
