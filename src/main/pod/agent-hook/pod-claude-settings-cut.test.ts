import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PodClaudeSettingsCut, scanLegacyClaudes } from './pod-claude-settings-cut'

let dir = ''
let settingsPath = ''
const POD_ENTRY = '{"type":"command","command":"/h/.orca/agent-hooks/pod-agent-hook","args":[]}'
const WITH_POD = `{"model":"opus","hooks":{"Stop":[{"hooks":[${POD_ENTRY}]}]}}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-claude-cut-'))
  settingsPath = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakePs(listing: string, described: string, code = 0) {
  const calls: string[][] = []
  const run = vi.fn(async (spec: { args?: readonly string[] }) => {
    calls.push([...(spec.args ?? [])])
    const stdout = spec.args?.[0] === '-Ao' ? listing : described
    return { code, signal: null, stdout, stderr: '', timedOut: false }
  })
  return { run, calls }
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
  function cutWith(scan: () => Promise<number[] | null>) {
    const watchers: { pids: number[]; cancelled: boolean; exit: () => void }[] = []
    const cut = new PodClaudeSettingsCut({
      settingsPath: () => settingsPath,
      agentHooksDir: () => dir,
      names: () => ({ hookScript: 'claude-hook.sh', statusLineScript: 'claude-statusline.sh' }),
      scan,
      awaitExit: (pids) => {
        let exit: () => void = () => {}
        const exited = new Promise<void>((resolve) => (exit = resolve))
        const watcher = { pids, cancelled: false, exit: () => exit() }
        watchers.push(watcher)
        return { exited, cancel: () => (watcher.cancelled = true) }
      }
    })
    return { cut, watchers }
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
})
