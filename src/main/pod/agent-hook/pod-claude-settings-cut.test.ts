import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  launcherAwaitExit,
  PodClaudeSettingsCut,
  scanLegacyClaudes,
  type PodClaudeSettingsCutOptions
} from './pod-claude-settings-cut'

let dir = ''
let settingsPath = ''
const POD_ENTRY = '{"type":"command","command":"/h/.orca/agent-hooks/pod-agent-hook","args":[]}'
const WITH_POD = `{"model":"opus","hooks":{"Stop":[{"hooks":[${POD_ENTRY}]}]}}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-claude-cut-'))
  settingsPath = join(dir, 'settings.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function fakePs(listing: string, described: string, code = 0, argv = '') {
  const calls: string[][] = []
  const run = vi.fn(async (spec: { args?: readonly string[] }) => {
    calls.push([...(spec.args ?? [])])
    const first = spec.args?.[0]
    const stdout = first === '-Ao' ? listing : first === '-ww' ? argv : described
    return { code, signal: null, stdout, stderr: '', timedOut: false }
  })
  return { run, calls }
}

/** A stand-in launcher: `--await-exit <pids>` runs `body`. */
function launcherScript(body: string): string {
  const path = join(dir, `launcher-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('scanLegacyClaudes', () => {
  it('names the claudes in Pod panes under this home that got no launch settings', async () => {
    const { run, calls } = fakePs(
      '  12 claude\n  13 /Users/h/.local/bin/claude\n  14 zsh\n  15 claude\n  16 claude\n',
      [
        '   12 claude --resume x HOME=/h ORCA_PANE_KEY=tab-1:a TERM=xterm',
        '   13 claude HOME=/h ORCA_PANE_KEY=tab-2:b POD_CLAUDE_SETTINGS_PID=13',
        '   15 claude HOME=/h TERM=xterm',
        '   16 claude HOME=/other ORCA_PANE_KEY=tab-3:c'
      ].join('\n')
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers the two ps calls the scan makes.
    expect(await scanLegacyClaudes('/h', run as never)).toEqual([12])
    expect(calls[1]).toEqual(['-E', '-ww', '-o', 'pid=,command=', '-p', '12,13,15,16'])
  })

  it("finds an npm install's claude, which runs as node", async () => {
    const { run, calls } = fakePs(
      '  20 node\n  21 /usr/local/bin/node\n  22 node\n  23 node\n  24 node\n',
      [
        '   20 node /h/.nvm/versions/node/v24/bin/claude HOME=/h ORCA_PANE_KEY=tab-1:a',
        '   21 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js HOME=/h ORCA_PANE_KEY=tab-2:b',
        '   23 claude HOME=/h ORCA_PANE_KEY=tab-3:c POD_CLAUDE_SETTINGS_PID=23'
      ].join('\n'),
      0,
      [
        '   20 node /h/.nvm/versions/node/v24/bin/claude --resume x',
        '   21 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '   22 node /h/server.js claude',
        '   23 claude',
        '   24 node /h/claude-code/cli.js'
      ].join('\n')
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers the three ps calls the scan makes.
    expect(await scanLegacyClaudes('/h', run as never)).toEqual([20, 21])
    expect(calls[1]).toEqual(['-ww', '-o', 'pid=,args=', '-p', '20,21,22,23,24'])
    expect(calls[2]).toEqual(['-E', '-ww', '-o', 'pid=,command=', '-p', '20,21,23'])
  })

  it('needs no second call without a claude, and gives up on an unreadable table', async () => {
    const none = fakePs('  1 launchd\n', '')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers ps.
    expect(await scanLegacyClaudes('/h', none.run as never)).toEqual([])
    expect(none.calls).toHaveLength(1)
    const broken = fakePs('', '', 1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake answers ps.
    expect(await scanLegacyClaudes('/h', broken.run as never)).toBe(null)
  })
})

describe('PodClaudeSettingsCut', () => {
  function cutWith(
    scan: () => Promise<number[] | null>,
    awaitExit?: PodClaudeSettingsCutOptions['awaitExit']
  ) {
    const watchers: { pids: number[]; cancelled: boolean; exit: () => void }[] = []
    const log = vi.fn()
    const cut = new PodClaudeSettingsCut({
      settingsPath: () => settingsPath,
      agentHooksDir: () => dir,
      names: () => ({ hookScript: 'claude-hook.sh', statusLineScript: 'claude-statusline.sh' }),
      scan,
      log,
      awaitExit:
        awaitExit ??
        ((pids) => {
          let exit: () => void = () => {}
          const exited = new Promise<boolean>((resolve) => (exit = () => resolve(true)))
          const watcher = { pids, cancelled: false, exit: () => exit() }
          watchers.push(watcher)
          return { exited, cancel: () => (watcher.cancelled = true) }
        })
    })
    return { cut, watchers, log }
  }

  it('stays unarmed, and never reads the process table, when settings.json has none of Pod', async () => {
    writeFileSync(settingsPath, '{"model":"opus"}')
    const scan = vi.fn(async () => [])
    const { cut } = cutWith(scan)
    await cut.arm()
    expect(cut.pending).toBe(false)
    expect(scan).not.toHaveBeenCalled()
  })

  it('waits while the table is unreadable, and watches the newest set of older claudes', async () => {
    writeFileSync(settingsPath, WITH_POD)
    let answer: number[] | null = null
    const { cut, watchers } = cutWith(async () => answer)
    await cut.arm()
    expect(cut.pending).toBe(true)
    expect(watchers).toHaveLength(0)
    answer = [5]
    cut.noteAgentChange()
    await cut.settled()
    answer = [5, 6]
    cut.noteAgentChange()
    await cut.settled()
    expect(watchers.map((w) => [w.pids, w.cancelled])).toEqual([
      [[5], true],
      [[5, 6], false]
    ])
    expect(readFileSync(settingsPath, 'utf8')).toBe(WITH_POD)
    answer = []
    watchers[1].exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cut.settled()
    expect(cut.pending).toBe(false)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('disarms when Pod hands back to settings.json, stopping its watcher', async () => {
    writeFileSync(settingsPath, WITH_POD)
    const { cut, watchers } = cutWith(async () => [8])
    await cut.arm()
    cut.disarm()
    expect(cut.pending).toBe(false)
    expect(watchers[0].cancelled).toBe(true)
  })

  it('starts a watcher that fails at once only once, and tries again after a growing pause', async () => {
    vi.useFakeTimers()
    writeFileSync(settingsPath, WITH_POD)
    let answer = [5]
    const spawned: number[][] = []
    const { cut, log } = cutWith(
      async () => answer,
      (pids) => {
        spawned.push(pids)
        return { exited: Promise.resolve(false), cancel: () => {} }
      }
    )
    await cut.arm()
    await vi.advanceTimersByTimeAsync(999)
    expect(spawned).toEqual([[5]])
    // A new set while it can't run: the retry starts the next one, not the change.
    answer = [5, 6]
    cut.noteAgentChange()
    await cut.settled()
    expect(spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawned).toEqual([[5], [5, 6]])
    await vi.advanceTimersByTimeAsync(1999)
    expect(spawned).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawned).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(spawned).toHaveLength(4)
    expect(
      log.mock.calls.filter(([event]) => event === 'pod-claude-settings-cut-watch-failed')
    ).toEqual([['pod-claude-settings-cut-watch-failed', { legacyClaudes: 1 }]])
    expect(cut.pending).toBe(true)
    cut.disarm()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawned).toHaveLength(4)
  })

  it('never starts the same watcher again at once when its claude is still listed after it said exited', async () => {
    vi.useFakeTimers()
    writeFileSync(settingsPath, WITH_POD)
    const spawned: number[][] = []
    const { cut } = cutWith(
      async () => [7],
      (pids) => {
        spawned.push(pids)
        return { exited: Promise.resolve(true), cancel: () => {} }
      }
    )
    await cut.arm()
    await vi.advanceTimersByTimeAsync(999)
    expect(spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawned).toHaveLength(2)
    cut.disarm()
  })

  it("with the launcher missing: one spawn, no loop of the process table (agent-api's probe)", async () => {
    writeFileSync(settingsPath, WITH_POD)
    let spawns = 0
    const scan = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [5]
    })
    const { cut } = cutWith(scan, (pids) => {
      spawns += 1
      return launcherAwaitExit(join(dir, 'missing', 'pod-agent-launcher'), pids)
    })
    await cut.arm()
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(spawns).toBe(1)
    expect(scan).toHaveBeenCalledTimes(1)
    cut.disarm()
  })
})

describe('launcherAwaitExit', () => {
  it('is true only when the watcher exits 0 with the pid it saw exit', async () => {
    expect(await launcherAwaitExit(launcherScript('echo "$2"'), [42]).exited).toBe(true)
    expect(await launcherAwaitExit(launcherScript('exit 0'), [42]).exited).toBe(false)
    expect(await launcherAwaitExit(launcherScript('echo 42; exit 3'), [42]).exited).toBe(false)
    expect(await launcherAwaitExit(join(dir, 'missing'), [42]).exited).toBe(false)
    const waiting = launcherAwaitExit(launcherScript('exec sleep 30'), [42])
    waiting.cancel()
    expect(await waiting.exited).toBe(false)
  })
})
