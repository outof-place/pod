// Fork-only (Pod): every linear.* method the runtime registers has an access rule, so a method
// upstream adds can't reach agents or change the key without a decision here.
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods'
import { LINEAR_AGENT_ACCESS_METHODS } from '../../runtime/rpc/methods/linear-agent-access'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { POD_LINEAR_ADMIN_METHODS, POD_LINEAR_AGENT_METHODS } from './pod-linear-access'

// Linear methods the user's own UI calls, Pod's window or PodNative, over its own connection.
const APP_METHODS = [
  'linear.addIssueComment',
  'linear.createIssue',
  'linear.createProject',
  'linear.getCustomView',
  'linear.getIssue',
  'linear.getIssues',
  'linear.getProject',
  'linear.issueComments',
  'linear.listCustomViewIssues',
  'linear.listCustomViewProjects',
  'linear.listCustomViews',
  'linear.listIssues',
  'linear.listProjectIssues',
  'linear.listProjects',
  'linear.listTeams',
  'linear.searchIssues',
  'linear.status',
  'linear.teamLabels',
  'linear.teamMembers',
  'linear.teamStates',
  'linear.testConnection',
  'linear.updateIssue'
]

describe('every linear.* method has a rule', () => {
  it('classifies each registered method once', () => {
    const registered = ALL_RPC_METHODS.map((method) => method.name).filter((name) =>
      name.startsWith('linear.')
    )
    const classified = [...POD_LINEAR_ADMIN_METHODS, ...POD_LINEAR_AGENT_METHODS, ...APP_METHODS]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...registered].sort()).toEqual([...classified].sort())
  })

  it('counts every method of linear-agent-access.ts as an agent method', () => {
    for (const method of LINEAR_AGENT_ACCESS_METHODS) {
      expect(POD_LINEAR_AGENT_METHODS.has(method.name)).toBe(true)
    }
  })

  // Only the unary dispatcher runs them in the agent call scope (pod-linear-call-scope.ts).
  it('registers every agent method as one-shot, not streaming', () => {
    const streaming = ALL_RPC_METHODS.filter(
      (method) => POD_LINEAR_AGENT_METHODS.has(method.name) && 'streaming' in method
    )
    expect(streaming.map((method) => method.name)).toEqual([])
  })

  it('keeps every admin method off the phone allowlist', () => {
    expect([...POD_LINEAR_ADMIN_METHODS].filter((m) => MOBILE_RPC_METHOD_ALLOWLIST.has(m))).toEqual(
      []
    )
  })
})
