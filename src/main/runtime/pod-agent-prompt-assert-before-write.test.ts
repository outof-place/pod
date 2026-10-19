// Fork-only (Pod): sendTerminalAgentPrompt runs `assertBeforeWrite` in each write's own block, so
// the foreground group check refuses a paste or an Enter with nothing written.
import { describe, expect, it, vi } from 'vitest'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const terminalRows = vi.fn<() => Promise<ProcessTableRow[] | null>>()
const groupNow = vi.fn<() => number | null>()

vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: () => terminalRows(),
  terminalOf: async () => 'ttys009'
}))
vi.mock('../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => groupNow()
}))

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { store, TEST_WORKTREE_PATH } = await import('./orca-runtime-test-fixtures.spec')

async function runtimeWithTerminal(listsProcesses = false) {
  const write = vi.fn((_ptyId: string, _data: string) => true)
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-assert' }),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    ...(listsProcesses
      ? {
          listProcesses: async () => [
            { id: 'pty-assert', rootProcessId: 100, cwd: '/tmp', title: 'zsh' }
          ]
        }
      : {})
  })
  const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    launchAgent: 'claude'
  })
  return { runtime, handle, write }
}

describe('sendTerminalAgentPrompt assertBeforeWrite', () => {
  it('writes nothing when the check refuses the paste', async () => {
    const { runtime, handle, write } = await runtimeWithTerminal()

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving',
        composerReady: true,
        assertBeforeWrite: () => {
          throw new Error('agent_not_in_foreground')
        }
      })
    ).rejects.toThrow('agent_not_in_foreground')
    expect(write).not.toHaveBeenCalled()
  })

  it('checks again right before Enter, which it refuses once the agent left', async () => {
    const { runtime, handle, write } = await runtimeWithTerminal()
    let checks = 0

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this change', {
        inputKind: 'driving',
        composerReady: true,
        assertBeforeWrite: () => {
          checks += 1
          if (checks > 1) {
            throw new Error('agent_not_in_foreground')
          }
        }
      })
    ).rejects.toThrow('agent_not_in_foreground')
    expect(checks).toBe(2)
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[1]).toContain('review this change')
    expect(write.mock.calls.some(([, data]) => data === '\r')).toBe(false)
  })

  // A dispatch inject or a coordinator task dispatch brings no check of its own.
  it.each([
    ['refuses', 'the shell', 101, 0],
    ['writes', 'the agent', 202, 1]
  ] as const)(
    '%s a caller without its own check while %s holds a local terminal',
    async (_verb, _who, front, writes) => {
      const row = (pid: number, command: string): ProcessTableRow => ({
        pid,
        ppid: 1,
        pgid: pid,
        tpgid: front,
        stat: 'S',
        command
      })
      terminalRows.mockResolvedValue([
        row(100, 'login -pfl user /bin/zsh'),
        row(101, '-zsh'),
        ...(front === 202 ? [row(202, 'claude')] : [])
      ])
      groupNow.mockReturnValue(front)
      const { runtime, handle, write } = await runtimeWithTerminal(true)

      const sent = runtime
        .sendTerminalAgentPrompt(handle, 'review this change', {
          inputKind: 'driving',
          composerReady: true
        })
        .catch((error: Error) => error)
      if (writes === 0) {
        const outcome = await sent
        expect(outcome).toBeInstanceOf(Error)
        expect(outcome).toMatchObject({ message: 'agent_not_in_foreground' })
        expect(write).not.toHaveBeenCalled()
      } else {
        await vi.waitFor(() => expect(write).toHaveBeenCalled())
        expect(write.mock.calls[0]?.[1]).toContain('review this change')
      }
    }
  )
})
