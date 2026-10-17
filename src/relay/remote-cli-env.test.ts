import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Orca terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        POD_TERMINAL_HANDLE: 'term_ssh',
        POD_WORKTREE_ID: 'repo::remote',
        POD_PANE_KEY: 'pane-1',
        POD_AGENT_LAUNCH_TOKEN: 'launch-secret',
        POD_WORKSPACE_ID: 'workspace-1',
        POD_USER_DATA_PATH: '/tmp/orca',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      POD_TERMINAL_HANDLE: 'term_ssh',
      POD_WORKTREE_ID: 'repo::remote',
      POD_PANE_KEY: 'pane-1',
      POD_AGENT_LAUNCH_TOKEN: 'launch-secret',
      POD_WORKSPACE_ID: 'workspace-1',
      POD_USER_DATA_PATH: '/tmp/orca',
      PATH: '/usr/bin'
    })
  })
})
