import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../shared/setup-script-imports'

export type HooksApi = {
  /** `ref` (Pod): that ref's committed orca.yaml instead of the root checkout's, and whether the
   *  ref is the repo's own branch (`baseOwned`). */
  check: (args: { repoId: string; hostId?: ExecutionHostId; ref?: string }) => Promise<{
    status?: 'ok' | 'error'
    hasHooks: boolean
    hooks: OrcaHooks | null
    mayNeedUpdate: boolean
    baseOwned?: boolean
  }>
  inspectSetupScriptImports: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }) => Promise<SetupScriptImportCandidate[]>
  createIssueCommandRunner: (args: {
    repoId: string
    worktreePath: string
    command: string
  }) => Promise<WorktreeSetupLaunch>
  readIssueCommand: (args: { repoId: string; hostId?: ExecutionHostId }) => Promise<{
    status?: 'ok' | 'error'
    localContent: string | null
    sharedContent: string | null
    effectiveContent: string | null
    localFilePath: string
    source: 'local' | 'shared' | 'none'
  }>
  writeIssueCommand: (args: {
    repoId: string
    content: string
    hostId?: ExecutionHostId
  }) => Promise<void>
}
