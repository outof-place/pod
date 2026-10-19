// Fork-only (Pod): a guarded prompt checks the foreground group in the block of each of its writes,
// and still sends what each agent needs: Codex's second Enter, and OMP's Enter inside the paste's
// frame. Once the check fails, nothing more is written.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../shared/agent-prompt-injection'
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

/** A pane whose agent turns to work at its Enter, and the writes the guard's check saw before. */
async function promptPane(agent: 'codex' | 'omp') {
  const order: string[] = []
  const pane = await createAgentPromptSubmissionRuntime((runtime, data) => {
    order.push(`write:${JSON.stringify(data)}`)
    if (data.endsWith('\r')) {
      runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    }
  }, agent)
  return { ...pane, order }
}

describe('a guarded prompt', () => {
  it('checks before each of Codex’s writes: the paste, its Enter and the second Enter', async () => {
    vi.useFakeTimers()
    const pane = await promptPane('codex')
    const atWrite = vi.fn(() => pane.order.push('check'))

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'launch',
      composerReady: true,
      atWrite
    })
    await vi.runAllTimersAsync()
    await sent

    expect(pane.writes.filter((data) => data === '\r')).toHaveLength(2)
    expect(pane.order.filter((step) => step === 'check')).toHaveLength(pane.writes.length)
    // Each check comes right before its own write.
    pane.order.forEach((step, index) => {
      expect(step === 'check' ? pane.order[index + 1] : pane.order[index - 1]).toMatch(
        step === 'check' ? /^write:/ : /^check$/
      )
    })
  })

  it('keeps OMP’s Enter inside the paste’s write, checked once', async () => {
    vi.useFakeTimers()
    const pane = await promptPane('omp')
    const atWrite = vi.fn()

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving',
      atWrite
    })
    await vi.runAllTimersAsync()
    await sent

    expect(pane.writes).toHaveLength(1)
    expect(pane.writes[0]?.endsWith(`${AGENT_PROMPT_BRACKETED_PASTE_END}\r`)).toBe(true)
    expect(atWrite).toHaveBeenCalledOnce()
  })

  it('writes no Enter once the check fails after the paste', async () => {
    vi.useFakeTimers()
    const pane = await promptPane('codex')
    let checks = 0
    const atWrite = vi.fn(() => {
      checks += 1
      if (checks > 1) {
        throw new Error('agent_not_in_foreground')
      }
    })

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'launch',
      composerReady: true,
      atWrite
    })
    const refused = expect(sent).rejects.toThrow('agent_not_in_foreground')
    await vi.runAllTimersAsync()
    await refused

    expect(pane.writes).toHaveLength(1)
    expect(pane.writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
  })
})
