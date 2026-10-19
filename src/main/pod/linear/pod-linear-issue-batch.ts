// Fork-only (Pod): linear.getIssues, many issues by id in one request per workspace, for PodNative's
// cards. Auth and rate-limit failures follow linear.getIssue: typed for one workspace; under "all",
// a failing workspace is skipped, and when none answers, a rate limit is the error.
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'
import { getClients, isAuthError, type LinearClientForWorkspace } from '../../linear/client'
import {
  LINEAR_ISSUE_NODE_FIELDS,
  type LinearIssueConnectionResponse,
  type LinearRawVariables
} from '../../linear/linear-issue-query-documents'
import {
  mapRawIssueForWorkspace,
  shouldThrowAuthError
} from '../../linear/linear-issue-query-support'
import { acquire, release } from '../../linear/linear-request-concurrency'
import { clearToken } from '../../linear/linear-token-store'
import { linearRateLimitFrom, throwIfLinearRateLimited } from './pod-linear-rate-limit'
import { withLinearIssueNames } from './pod-linear-issue-names'

const ISSUES_BY_IDS_QUERY = `
  query PodLinearIssuesByIds($ids: [ID!], $first: Int) {
    issues(filter: { id: { in: $ids } }, first: $first) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
    }
  }
`

export type LinearIssueBatch = {
  /** In the order asked for; an id no workspace returned is in `missing`. */
  issues: LinearIssue[]
  missing: string[]
}

async function readWorkspace(
  entry: LinearClientForWorkspace,
  ids: string[]
): Promise<LinearIssue[]> {
  await acquire()
  try {
    const result = await entry.client.client.rawRequest<
      LinearIssueConnectionResponse,
      LinearRawVariables
    >(ISSUES_BY_IDS_QUERY, { ids, first: ids.length })
    return (result.data?.issues?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue))
  } finally {
    release()
  }
}

export async function getLinearIssuesByIds(
  requested: string[],
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssueBatch> {
  const ids = [...new Set(requested)]
  const found = new Map<string, LinearIssue>()
  const entries = getClients(workspaceId)
  let rateLimited: unknown = null
  let answered = 0
  for (const entry of entries) {
    const pending = ids.filter((id) => !found.has(id))
    if (pending.length === 0) {
      break
    }
    try {
      for (const issue of await readWorkspace(entry, pending)) {
        found.set(issue.id, issue)
      }
      answered += 1
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
      }
      if (shouldThrowAuthError(workspaceId)) {
        if (isAuthError(error)) {
          throw error
        }
        throwIfLinearRateLimited(error)
      }
      if (linearRateLimitFrom(error)) {
        rateLimited = error
      }
      console.warn('[linear] getIssues failed:', error)
    }
  }
  if (answered === 0 && rateLimited !== null) {
    throwIfLinearRateLimited(rateLimited)
  }
  return {
    issues: ids.flatMap((id) => {
      const issue = found.get(id)
      return issue ? [withLinearIssueNames(issue)] : []
    }),
    missing: ids.filter((id) => !found.has(id))
  }
}
