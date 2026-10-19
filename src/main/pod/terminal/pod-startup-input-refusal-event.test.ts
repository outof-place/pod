// Fork-only (Pod): a startup follow-up that never reached its agent is reported to clients as a
// runtime client event, with the terminal's handle and the reason, not only logged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { createAgentPromptSubmissionRuntime } from '../../runtime/agent-prompt-submission-runtime-test-fixture'

vi.mock('../../git/worktree', () => {
  const worktree = {
    path: '/tmp/worktree-a',
    head: 'abc',
    branch: 'feature/prompt-verification',
    isBare: false,
    isMainWorktree: false
  }
  return {
    listWorktrees: vi.fn().mockResolvedValue([worktree]),
    listWorktreesStrict: vi.fn().mockResolvedValue([worktree])
  }
})

afterEach(() => vi.useRealTimers())

describe('a startup follow-up the agent never took', () => {
  it('reaches clients as startupInputRefused, with nothing written', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {})
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    vi.useFakeTimers()

    const delivered = runtime.deliverStartupFollowup(handle, {
      expectedProcess: 'aider',
      prompt: 'fix it'
    })
    await vi.runAllTimersAsync()

    await expect(delivered).resolves.toBe(false)
    expect(writes).toEqual([])
    expect(events).toContainEqual({
      type: 'startupInputRefused',
      terminalHandle: handle,
      input: 'followup',
      reason: 'agent_not_ready'
    })
  })
})
