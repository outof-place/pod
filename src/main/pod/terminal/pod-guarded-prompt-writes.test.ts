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
async function promptPane(
  agent: 'codex' | 'omp',
  getForegroundProcess?: (ptyId: string) => Promise<string | null>
) {
  const order: string[] = []
  const pane = await createAgentPromptSubmissionRuntime(
    (runtime, data) => {
      order.push(`write:${JSON.stringify(data)}`)
      if (data.endsWith('\r')) {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    },
    agent,
    getForegroundProcess
  )
  return { ...pane, order }
}

/** The pane as an SSH host's, with the runtime's own proof: its relay names who is in front. */
async function sshPromptPane(relayNames: () => string | null) {
  const pane = await promptPane('codex', async () => relayNames())
  vi.mocked(pane.runtime.proveTerminalAgentForegroundFence).mockRestore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime keeps its pane records in ptysById; the test only marks this pane as an SSH host's.
  const ptys = (pane.runtime as unknown as { ptysById: Map<string, object> }).ptysById
  const record = ptys.get('pty-prompt')
  expect(record).toBeDefined()
  Object.assign(record ?? {}, { connectionId: 'ssh-build-host' })
  return pane
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

  // No local proof on SSH: the relay's read stands in, and a shell it names refuses the write.
  it('writes nothing to an SSH pane whose relay names a shell in front', async () => {
    vi.useFakeTimers()
    const pane = await sshPromptPane(() => '-zsh')

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving'
    })
    const refused = expect(sent).rejects.toThrow('agent_not_in_foreground: shell')
    await vi.runAllTimersAsync()
    await refused

    expect(pane.writes).toEqual([])
  })

  it('sends the Enter to an SSH pane only while its relay names no shell', async () => {
    vi.useFakeTimers()
    let front = 'codex'
    const pane = await sshPromptPane(() => front)
    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving'
    })
    const refused = expect(sent).rejects.toThrow('agent_not_in_foreground: shell')
    await vi.advanceTimersByTimeAsync(0)
    expect(pane.writes).toHaveLength(1)

    front = '-zsh'
    await vi.runAllTimersAsync()
    await refused

    expect(pane.writes).toHaveLength(1)
  })

  it('lets the paste and its Enter through to an SSH pane with the agent in front', async () => {
    vi.useFakeTimers()
    const pane = await sshPromptPane(() => 'codex')

    const sent = pane.runtime.sendTerminalAgentPrompt(pane.handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()
    await sent

    expect(pane.writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(pane.writes).toContain('\r')
  })
})
