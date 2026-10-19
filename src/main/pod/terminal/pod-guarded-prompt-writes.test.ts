// Fork-only (Pod): a guarded prompt checks the foreground group in the block of each of its writes,
// and still sends what each agent needs: Codex's second Enter, and OMP's Enter inside the paste's
// frame. Once the check fails, nothing more is written.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from '../../runtime/agent-prompt-submission-runtime-test-fixture'
import type { TerminalAgentForegroundProof } from './pod-terminal-foreground-fence'

const fence = vi.hoisted((): { groupNow: number | null } => ({ groupNow: null }))
vi.mock('./pod-terminal-foreground-read', () => ({
  readTerminalForegroundGroupNow: () =>
    fence.groupNow === null
      ? { ok: false, reason: 'read_failed' }
      : { ok: true, group: fence.groupNow }
}))

const AGENT_GROUP = 200
const AGENT_PROOF: TerminalAgentForegroundProof = {
  verdict: 'agent',
  fence: { rootPid: 100, tty: 'ttys007', foregroundGroup: AGENT_GROUP }
}

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

afterEach(() => {
  vi.useRealTimers()
  fence.groupNow = null
})

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

// A prompt from a caller with no guard of its own: dispatch --inject, a coordinator's task, the CLI.
describe('the default gate of an unguarded agent prompt', () => {
  it('lets the paste and its Enter through while a recognized agent holds the terminal', async () => {
    vi.useFakeTimers()
    const pane = await promptPane('codex')
    vi.mocked(pane.runtime.proveTerminalAgentForegroundFence).mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()
    await sent

    expect(pane.writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(pane.writes).toContain('\r')
  })

  it.each(['shell', 'not_agent', 'unknown'] as const)(
    'writes nothing when the proof finds %s',
    async (verdict) => {
      vi.useFakeTimers()
      const pane = await promptPane('codex')
      vi.mocked(pane.runtime.proveTerminalAgentForegroundFence).mockResolvedValue({ verdict })

      const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
        inputKind: 'driving'
      })
      const refused = expect(sent).rejects.toThrow(`agent_not_in_foreground: ${verdict}`)
      await vi.runAllTimersAsync()
      await refused

      expect(pane.writes).toEqual([])
    }
  )

  it('writes no Enter once the agent left after the paste', async () => {
    vi.useFakeTimers()
    const pane = await promptPane('codex')
    vi.mocked(pane.runtime.proveTerminalAgentForegroundFence).mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP
    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving'
    })
    const refused = expect(sent).rejects.toThrow('agent_not_in_foreground: group_changed')
    await vi.advanceTimersByTimeAsync(0)
    expect(pane.writes).toHaveLength(1)

    fence.groupNow = 101
    await vi.runAllTimersAsync()
    await refused

    expect(pane.writes).toHaveLength(1)
  })
})
