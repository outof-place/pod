// Fork-only (Pod): an issue's worktree name and branch, as the classic window's New Worktree builds them.
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { LINEAR_METHODS } from '../../runtime/rpc/methods/linear'
import { withLinearOn } from './pod-linear-access.test-support'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { withLinearIssueNames } from './pod-linear-issue-names'

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-9',
    identifier: 'ENG-9',
    title: 'Fix login on Safari',
    url: 'https://linear.app/mock-co/issue/ENG-9/fix-login-on-safari',
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides
  }
}

describe('withLinearIssueNames', () => {
  it('names the worktree after the key and title, as New Worktree does', () => {
    const named = withLinearIssueNames(issue())
    expect(named.suggestedWorktreeName).toBe(getLinearIssueWorkspaceName(issue()))
    expect(named.suggestedWorktreeName).toBe('eng-9-fix-login-on-safari')
  })

  it('takes Linear’s branch name trimmed, and none when it is blank or missing', () => {
    expect(
      withLinearIssueNames(issue({ branchName: ' ada/eng-9-fix-login ' })).usableBranchName
    ).toBe('ada/eng-9-fix-login')
    expect(withLinearIssueNames(issue({ branchName: '   ' }))).not.toHaveProperty(
      'usableBranchName'
    )
    expect(withLinearIssueNames(issue())).not.toHaveProperty('usableBranchName')
  })
})

describe('linear.getIssue and linear.searchIssues', () => {
  withLinearOn()

  it('answer with each issue’s worktree name and branch', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearGetIssue: vi.fn().mockResolvedValue(issue({ branchName: 'ada/eng-9' })),
      linearSearchIssues: vi.fn().mockResolvedValue([issue()])
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two methods under test call only these runtime members.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: LINEAR_METHODS
    })
    const call = (method: string, params: unknown) =>
      dispatcher.dispatch({ id: 'req-1', authToken: 'tok', method, params })

    expect(await call('linear.getIssue', { id: 'issue-9' })).toMatchObject({
      ok: true,
      result: { suggestedWorktreeName: 'eng-9-fix-login-on-safari', usableBranchName: 'ada/eng-9' }
    })
    expect(await call('linear.searchIssues', { query: 'login' })).toMatchObject({
      ok: true,
      result: [{ suggestedWorktreeName: 'eng-9-fix-login-on-safari' }]
    })
  })
})
