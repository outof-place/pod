// Fork-only (Pod): while Linear is off, every linear:* IPC channel but linear:status refuses with
// linear_unavailable before any Linear code runs; on, they answer as before.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { setPodLinearEnabledSetting } from './pod-linear-availability'

const linear = vi.hoisted(() => {
  const spy = () => vi.fn(async () => [])
  return {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    client: {
      connect: spy(),
      disconnect: spy(),
      getStatus: vi.fn(() => ({ connected: false, viewer: null })),
      selectWorkspace: spy(),
      testConnection: spy()
    },
    lookups: { getIssue: spy(), searchIssues: spy() },
    listing: { listIssues: spy() },
    mutations: { createIssue: spy(), updateIssue: spy() },
    comments: { addIssueComment: spy(), getIssueComments: spy() },
    projects: {
      createProject: spy(),
      getCustomView: spy(),
      getProject: spy(),
      listCustomViewIssues: spy(),
      listCustomViewProjects: spy(),
      listCustomViews: spy(),
      listProjectIssues: spy(),
      listProjects: spy()
    },
    teams: { listTeams: spy(), getTeamStates: spy(), getTeamLabels: spy(), getTeamMembers: spy() }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      linear.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../linear/client', () => linear.client)
vi.mock('../../linear/linear-issue-lookups', () => linear.lookups)
vi.mock('../../linear/linear-issue-listing', () => linear.listing)
vi.mock('../../linear/linear-issue-mutations', () => linear.mutations)
vi.mock('../../linear/linear-issue-comments', () => linear.comments)
vi.mock('../../linear/projects', () => linear.projects)
vi.mock('../../linear/teams', () => linear.teams)
vi.mock('../../ipc/preflight', () => ({ _resetPreflightCache: vi.fn() }))

import { registerLinearHandlers } from '../../ipc/linear'

const LINEAR_CODE = [
  linear.client,
  linear.lookups,
  linear.listing,
  linear.mutations,
  linear.comments,
  linear.projects,
  linear.teams
].flatMap((module) => Object.values(module))

function preloadChannels(): string[] {
  const bridge = readFileSync(join(__dirname, '../../../preload/api/linear-bridge.ts'), 'utf8')
  return [...new Set(bridge.match(/'linear:[A-Za-z]+'/g) ?? [])].map((name) => name.slice(1, -1))
}

async function refusal(channel: string): Promise<unknown> {
  const handler = linear.handlers.get(channel)
  try {
    await handler?.({}, { workspaceId: 'org-mock-1', id: 'issue-9', query: 'login', apiKey: 'k' })
  } catch (error) {
    return error
  }
  return null
}

afterEach(() => {
  setPodLinearEnabledSetting(null)
  vi.clearAllMocks()
})

describe('linear:* IPC while Linear is off', () => {
  it('registers every channel the preload bridge calls, all through the gate', () => {
    registerLinearHandlers()
    expect([...linear.handlers.keys()].sort()).toEqual(preloadChannels().sort())
    expect(linear.handlers.size).toBe(24)
  })

  it('refuses every channel but linear:status, and runs no Linear code', async () => {
    registerLinearHandlers()
    for (const channel of linear.handlers.keys()) {
      if (channel === 'linear:status') {
        continue
      }
      const error = await refusal(channel)
      expect(hasRuntimeRpcErrorCode(error, 'linear_unavailable'), channel).toBe(true)
      expect(
        hasRuntimeRpcErrorCode(
          new Error(`Error invoking remote method '${channel}': ${String(error)}`),
          'linear_unavailable'
        )
      ).toBe(true)
    }
    for (const fn of LINEAR_CODE) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('still answers linear:status', async () => {
    registerLinearHandlers()
    expect(await linear.handlers.get('linear:status')?.({})).toEqual({
      connected: false,
      viewer: null
    })
  })

  it('answers as before once Linear is on', async () => {
    setPodLinearEnabledSetting({ read: () => true, write: () => {} })
    registerLinearHandlers()

    expect(await refusal('linear:searchIssues')).toBeNull()
    expect(linear.lookups.searchIssues).toHaveBeenCalledTimes(1)
  })
})
