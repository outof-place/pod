import { describe, expect, it } from 'vitest'
import {
  resolvePaneRestartStartup,
  resolveTerminalProcessExitRestartStartup
} from './terminal-process-exit-restart'

describe('terminal process exit restart', () => {
  it('retries the original startup after a Git Bash capacity failure', () => {
    const startup = { command: 'codex --resume session-1' }

    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 1,
        reason: 'git-bash-console-capacity',
        startup
      })
    ).toBe(startup)
  })

  it('restarts a shell when a capacity failure had no startup request', () => {
    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 1,
        reason: 'git-bash-console-capacity',
        startup: null
      })
    ).toBeNull()
  })

  it('restarts other process failures as a shell', () => {
    expect(
      resolveTerminalProcessExitRestartStartup({
        paneId: 1,
        exitCode: 7,
        reason: 'process-failed',
        startup: { command: 'codex' }
      })
    ).toBeNull()
  })

  // Fork-only (Pod): the desktop's Restart of a failed shell started Codex.
  it('restarts a failed shell as a plain shell, and only a bare restart as Codex', () => {
    const codex = { command: 'codex' }
    expect(resolvePaneRestartStartup(null, () => codex)).toBeNull()
    expect(resolvePaneRestartStartup({ command: 'zsh -l' }, () => codex)).toEqual({
      command: 'zsh -l'
    })
    expect(resolvePaneRestartStartup(undefined, () => codex)).toBe(codex)
  })
})
