import { describe, expect, it } from 'vitest'
import { createWorkspacePlanStore, WORKSPACE_PLAN_TTL_MS } from './workspace-plan-store'

describe('workspace plan store', () => {
  it('backs an apply only with the fingerprint it recorded, for its own kind', () => {
    const plans = createWorkspacePlanStore()
    const { planId } = plans.issue('tidy', new Map([['wt-1', 'aaa']]))
    expect(() => plans.verify(planId, 'tidy', 'wt-1', 'aaa')).not.toThrow()
    expect(() => plans.verify(planId, 'tidy', 'wt-1', 'bbb')).toThrow(/changed since you looked/)
    expect(() => plans.verify(planId, 'tidy', 'wt-2', 'aaa')).toThrow(/does not cover/)
    expect(() => plans.verify(planId, 'profile', 'wt-1', 'aaa')).toThrow(/expired/)
  })

  it('expires plans, and a consumed one is gone', () => {
    let now = 1_000
    const plans = createWorkspacePlanStore(() => now)
    const first = plans.issue('profile', new Map([['repo', 'x']]), 'repo-1')
    expect(plans.subjectOf(first.planId, 'profile')).toBe('repo-1')
    plans.consume(first.planId)
    expect(() => plans.subjectOf(first.planId, 'profile')).toThrow(/expired/)
    const second = plans.issue('profile', new Map([['repo', 'x']]), 'repo-1')
    now += WORKSPACE_PLAN_TTL_MS + 1
    expect(() => plans.expected(second.planId, 'profile', 'repo')).toThrow(/expired/)
  })

  it('caps plans per kind, so polling the status never evicts a tidy plan', () => {
    const plans = createWorkspacePlanStore()
    const tidy = plans.issue('tidy', new Map([['wt', 'f']]))
    const statuses = Array.from({ length: 40 }, () => plans.issue('status', new Map()))
    expect(plans.expected(tidy.planId, 'tidy', 'wt')).toBe('f')
    expect(() => plans.subjectOf(statuses[0].planId, 'status')).toThrow(/expired/)
  })
})
