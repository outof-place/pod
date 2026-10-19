// Fork-only (Pod): the worktree name and branch New Worktree takes from an issue, built by the same
// shared rules as the classic window, so PodNative ports neither.
import type { LinearIssue } from '../../../shared/linear/issue-types'
import { getUsableLinearBranchName } from '../../../shared/new-workspace/workspace-source'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'

export function withLinearIssueNames(issue: LinearIssue): LinearIssue {
  const usableBranchName = getUsableLinearBranchName(issue.branchName)
  return {
    ...issue,
    suggestedWorktreeName: getLinearIssueWorkspaceName(issue),
    ...(usableBranchName ? { usableBranchName } : {})
  }
}
