// Fork-only (Pod): a startup draft or follow-up goes in as plain text in one bracketed paste, each
// write proven and fenced; nothing of a refused write reaches the terminal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalAgentForegroundProof } from './pod-terminal-foreground-fence'
import {
  buildStartupPaste,
  sanitizeStartupPasteText,
  writeStartupFollowupGuarded,
  writeStartupInputGuarded
} from './pod-startup-input-write'

const mocks = vi.hoisted((): { groupNow: number | null } => ({ groupNow: null }))
vi.mock('./pod-terminal-foreground-read', () => ({
  readTerminalForegroundGroupNow: () =>
    mocks.groupNow === null
      ? { ok: false, reason: 'read_failed' }
      : { ok: true, group: mocks.groupNow }
}))

const AGENT_GROUP = 200
const AGENT: TerminalAgentForegroundProof = {
  verdict: 'agent',
  fence: { rootPid: 100, tty: 'ttys007', foregroundGroup: AGENT_GROUP }
}

function host(...proofs: (TerminalAgentForegroundProof | null)[]) {
  const write = vi.fn()
  const prove = vi.fn(async () => (proofs.length > 1 ? proofs.shift()! : proofs[0]!))
  return { write, prove, host: { write, proveTerminalAgentForegroundFence: prove } }
}

afterEach(() => {
  mocks.groupNow = null
  vi.useRealTimers()
})

describe('the startup paste', () => {
  // The bytes PodNative's AgentPromptText.sanitized gives for the same text.
  it.each([
    ['a paste end', 'a\x1b[201~b', 'a[201~b'],
    ['Ctrl-C', 'a\x03b', 'ab'],
    ['CR LF', 'a\r\nb', 'a\nb'],
    ['a lone CR', 'a\rb', 'ab'],
    ['a tab', 'a\tb', 'a b'],
    ['DEL', 'a\x7fb', 'ab'],
    ['C1, CSI included', 'a\x85b\x9bc', 'abc'],
    ['other C0', 'a\x00b\x07c\x1bd', 'abcd'],
    ['newlines and text', 'one\ntwo ✓', 'one\ntwo ✓']
  ])('filters %s', (_what, text, filtered) => {
    expect(sanitizeStartupPasteText(text)).toBe(filtered)
  })

  it('cannot be closed early by a paste end inside the text', () => {
    const paste = buildStartupPaste('plan\x1b[201~rm -rf ~\r')

    expect(paste).toBe('\x1b[200~plan[201~rm -rf ~\x1b[201~')
    expect(paste.indexOf('\x1b[201~')).toBe(paste.length - '\x1b[201~'.length)
  })
})

describe('a guarded startup write', () => {
  it('writes while the agent’s group is still in front', async () => {
    const h = host(AGENT)
    mocks.groupNow = AGENT_GROUP

    await writeStartupInputGuarded(h.host, 'pty-1', 'aider', 'x')

    expect(h.write).toHaveBeenCalledWith('pty-1', 'x', 'launch')
  })

  it.each([
    ['a shell holds the terminal', { verdict: 'shell' } as const, AGENT_GROUP, 'shell'],
    ['nothing can tell', { verdict: 'unknown' } as const, AGENT_GROUP, 'unknown'],
    ['the agent left after the proof', AGENT, 101, 'group_changed'],
    ['the foreground group cannot be read', AGENT, null, 'read_failed']
  ])('writes nothing when %s, and says why', async (_what, proof, groupNow, reason) => {
    const h = host(proof)
    mocks.groupNow = groupNow

    await expect(writeStartupInputGuarded(h.host, 'pty-1', 'aider', 'x')).rejects.toThrow(
      `agent_not_in_foreground: ${reason}`
    )
    expect(h.write).not.toHaveBeenCalled()
  })

  it('writes an SSH or Windows pane as before', async () => {
    const h = host(null)

    await writeStartupInputGuarded(h.host, 'pty-1', 'aider', 'x')

    expect(h.write).toHaveBeenCalledOnce()
  })
})

describe('a guarded follow-up', () => {
  it('pastes, then presses Enter as a write of its own with a proof of its own', async () => {
    vi.useFakeTimers()
    const h = host(AGENT)
    mocks.groupNow = AGENT_GROUP

    const done = writeStartupFollowupGuarded(h.host, 'pty-1', 'fix it')
    await vi.runAllTimersAsync()
    await done

    expect(h.write.mock.calls).toEqual([
      ['pty-1', '\x1b[200~fix it\x1b[201~', 'launch'],
      ['pty-1', '\r', 'launch']
    ])
    expect(h.prove).toHaveBeenCalledTimes(2)
  })

  it('withholds Enter when the agent exited after the paste', async () => {
    vi.useFakeTimers()
    const h = host(AGENT, { verdict: 'shell' })
    mocks.groupNow = AGENT_GROUP

    const done = writeStartupFollowupGuarded(h.host, 'pty-1', 'fix it')
    const refused = expect(done).rejects.toThrow('agent_not_in_foreground')
    await vi.runAllTimersAsync()
    await refused

    expect(h.write.mock.calls).toEqual([['pty-1', '\x1b[200~fix it\x1b[201~', 'launch']])
  })
})
