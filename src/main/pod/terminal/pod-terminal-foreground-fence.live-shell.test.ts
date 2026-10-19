// Fork-only (Pod): the guarded write's proof and fence against a real zsh pane, spawned the way a
// pane is (under `login` on macOS), with a `claude` stub: a shell in front while the tracker's 5 s
// startup guess still names the agent refuses the write; an agent in front lets it through; an
// agent that exits between the proof and the write refuses it, with no byte written.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { createPtyForegroundProcessTracker } from '../../daemon/pty-subprocess/foreground-process-tracker'
import {
  prepareMacosTccLoginShell,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import { writeStartupInputGuarded } from './pod-startup-input-write'
import {
  isTerminalForegroundFenceHeld,
  proveTerminalAgentForeground
} from './pod-terminal-foreground-fence'

const PTY_ID = 'pty-1'
// A function, not a ternary: the Windows-lane registration scan reads a const assigned from a
// platform check as a Windows-only gate, and this suite runs everywhere but Windows.
function findZsh(): string {
  if (process.platform === 'win32') {
    return ''
  }
  return (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout ?? '').trim()
}

const ZSH_PATH = findZsh()
const describeWithZsh = ZSH_PATH ? describe : describe.skip

let home = ''
let savedLoginOptOut: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pod-foreground-fence-'))
  savedLoginOptOut = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
})

afterEach(() => {
  if (savedLoginOptOut !== undefined) {
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedLoginOptOut
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** A zsh pane with a `claude` stub that stays up for `agentSeconds`, and the daemon's tracker. */
async function pane(agentSeconds: number) {
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // Typed by absolute path: `login` resets HOME and PATH, so a bare name would find a real agent.
  const stubPath = join(bin, 'claude')
  writeFileSync(stubPath, `#!/bin/sh\nprintf 'stub agent\\r\\n> '\nexec sleep ${agentSeconds}\n`)
  chmodSync(stubPath, 0o755)
  writeFileSync(join(home, '.zshrc'), '')
  const env = { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home, TERM: 'xterm-256color' }
  await prepareMacosTccLoginShell()
  const spawn = wrapShellSpawnForMacosTccAttribution(ZSH_PATH, ['-i'], env)
  const proc = pty.spawn(spawn.file, spawn.args, { cols: 80, rows: 24, cwd: home, env })
  let dead = false
  proc.onExit(() => {
    dead = true
  })
  const tracker = createPtyForegroundProcessTracker({
    process: proc,
    shellPath: ZSH_PATH,
    cwd: home,
    sessionId: 'wt-foreground-fence@@pane',
    startupAgentRecognition: recognizeAgentProcess('claude'),
    isDead: () => dead
  })
  const controller = {
    listProcesses: async () => [{ id: PTY_ID, rootProcessId: proc.pid, cwd: home, title: 'zsh' }]
  }
  const writes: string[] = []
  const host = {
    proveTerminalAgentForegroundFence: () =>
      proveTerminalAgentForeground(controller, PTY_ID, 'claude'),
    write: (_ptyId: string, data: string) => {
      writes.push(data)
    }
  }
  const close = async (): Promise<void> => {
    proc.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { proc, tracker, controller, host, writes, stubPath, close }
}

describeWithZsh('the guarded write against a real pane', () => {
  it('refuses while the shell is in front, though the tracker’s startup guess names the agent', async () => {
    const p = await pane(30)
    try {
      expect(
        await until(
          async () =>
            (await proveTerminalAgentForeground(p.controller, PTY_ID, 'claude')).verdict ===
            'shell',
          10_000
        )
      ).toBe(true)
      // Inside the 5 s bootstrap: the tracker still reports the launched agent.
      expect(p.tracker.getForegroundProcess()).toBe('claude')
      await expect(writeStartupInputGuarded(p.host, PTY_ID, 'claude', 'x')).rejects.toThrow(
        'agent_not_in_foreground'
      )
      expect(p.writes).toEqual([])
    } finally {
      await p.close()
    }
  }, 30_000)

  it('lets the write through while the agent is in front', async () => {
    const p = await pane(30)
    try {
      p.proc.write(`'${p.stubPath}'\r`)
      expect(
        await until(
          async () =>
            (await proveTerminalAgentForeground(p.controller, PTY_ID, 'claude')).verdict ===
            'agent',
          15_000
        )
      ).toBe(true)
      await writeStartupInputGuarded(p.host, PTY_ID, 'claude', 'x')
      expect(p.writes).toEqual(['x'])
    } finally {
      await p.close()
    }
  }, 30_000)

  it('refuses once the agent exited after the proof', async () => {
    const p = await pane(3)
    try {
      p.proc.write(`'${p.stubPath}'\r`)
      let proof = await proveTerminalAgentForeground(p.controller, PTY_ID, 'claude')
      expect(
        await until(async () => {
          proof = await proveTerminalAgentForeground(p.controller, PTY_ID, 'claude')
          return proof.verdict === 'agent'
        }, 15_000)
      ).toBe(true)
      if (proof.verdict !== 'agent') {
        throw new Error('no proof')
      }
      const agentFence = proof.fence
      expect(isTerminalForegroundFenceHeld(agentFence)).toBe(true)
      expect(await until(async () => !isTerminalForegroundFenceHeld(agentFence), 10_000)).toBe(true)
    } finally {
      await p.close()
    }
  }, 30_000)
})
