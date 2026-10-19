// Fork-only (Pod): linear.getIssues, many issues in one request per workspace, for PodNative's cards.
// Auth and rate-limit failures follow linear.getIssue: typed for one workspace; under "all", a
// failing workspace is skipped, and when none answers, a rate limit is the error.
import type { LinearIssue } from '../../../shared/linear/issue-types'
import { isLinearUuid } from '../../../shared/linear/uuid'
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

const ISSUES_BY_FILTER_QUERY = `
  query PodLinearIssuesByIds($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
    }
  }
`

// Linear documents the "ENG-9" shorthand for issue(id:) only, not for the id comparator in a
// filter, so an identifier is asked for as its team key and number.
const IDENTIFIER_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/

type IssueRef =
  | { input: string; uuid: string }
  | { input: string; identifier: string; teamKey: string; number: number }

export type LinearIssueBatch = {
  /** In the order asked for, once each; an id or identifier nothing matched is in `missing`. */
  issues: LinearIssue[]
  missing: string[]
}

function parseRef(input: string): IssueRef | null {
  if (isLinearUuid(input)) {
    return { input, uuid: input.toLowerCase() }
  }
  const match = IDENTIFIER_PATTERN.exec(input)
  const teamKey = match?.[1]?.toUpperCase()
  const number = match?.[2] === undefined ? Number.NaN : Number(match[2])
  return teamKey && Number.isSafeInteger(number)
    ? { input, identifier: `${teamKey}-${number}`, teamKey, number }
    : null
}

/** One IssueFilter for every ref: UUIDs by id, identifiers by team key and number. */
function linearIssueBatchFilter(refs: IssueRef[]): Record<string, unknown> {
  const uuids = refs.flatMap((ref) => ('uuid' in ref ? [ref.uuid] : []))
  const numbersByTeam = new Map<string, number[]>()
  for (const ref of refs) {
    if ('teamKey' in ref) {
      numbersByTeam.set(ref.teamKey, [...(numbersByTeam.get(ref.teamKey) ?? []), ref.number])
    }
  }
  return {
    or: [
      ...(uuids.length > 0 ? [{ id: { in: uuids } }] : []),
      ...[...numbersByTeam].map(([key, numbers]) => ({
        team: { key: { eq: key } },
        number: { in: numbers }
      }))
    ]
  }
}

function matches(ref: IssueRef, issue: LinearIssue): boolean {
  return 'uuid' in ref
    ? issue.id.toLowerCase() === ref.uuid
    : issue.identifier.toUpperCase() === ref.identifier
}

async function readWorkspace(
  entry: LinearClientForWorkspace,
  refs: IssueRef[]
): Promise<LinearIssue[]> {
  await acquire()
  try {
    const result = await entry.client.client.rawRequest<
      LinearIssueConnectionResponse,
      LinearRawVariables
    >(ISSUES_BY_FILTER_QUERY, { filter: linearIssueBatchFilter(refs), first: refs.length })
    return (result.data?.issues?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue))
  } finally {
    release()
  }
}

export async function getLinearIssuesByIds(
  requested: string[],
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssueBatch> {
  const inputs = [...new Set(requested)]
  const refs = inputs.flatMap((input) => parseRef(input) ?? [])
  const found = new Map<string, LinearIssue>()
  const entries = getClients(workspaceId)
  let rateLimited: unknown = null
  let answered = 0
  for (const entry of entries) {
    const pending = refs.filter((ref) => !found.has(ref.input))
    if (pending.length === 0) {
      break
    }
    try {
      const issues = await readWorkspace(entry, pending)
      for (const ref of pending) {
        const issue = issues.find((candidate) => matches(ref, candidate))
        if (issue) {
          found.set(ref.input, issue)
        }
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
  const seen = new Set<string>()
  const issues = inputs.flatMap((input) => {
    const issue = found.get(input)
    if (!issue || seen.has(issue.id)) {
      return []
    }
    seen.add(issue.id)
    return [withLinearIssueNames(issue)]
  })
  return { issues, missing: inputs.filter((input) => !found.has(input)) }
}
