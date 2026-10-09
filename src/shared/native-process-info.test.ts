import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadNativeProcessInfoFrom, type NativeProcessInfo } from './native-process-info'

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

/** `ps` columns for one pid, collapsed the way the pane fingerprint compares them. */
function psRow(pid: number): {
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  tty: string
  startTime: string
} {
  const line = execFileSync(
    'ps',
    ['-o', 'ppid=,pgid=,tpgid=,stat=,tty=,lstart=', '-p', String(pid)],
    {
      encoding: 'utf8'
    }
  ).trim()
  const [ppid, pgid, tpgid, stat, tty, ...start] = line.split(/\s+/)
  return {
    ppid: Number(ppid),
    pgid: Number(pgid),
    tpgid: Number(tpgid),
    stat,
    tty,
    startTime: start.join(' ')
  }
}

/** Only the bits Orca reads: stopped/zombie lifecycle, session leader, and foreground group. */
function jobControlBits(stat: string): string {
  return (
    (stat[0] === 'T' ? 'T' : stat[0] === 'Z' ? 'Z' : '') +
    (stat.includes('s') ? 's' : '') +
    (stat.includes('+') ? '+' : '')
  )
}

describe('loadNativeProcessInfoFrom', () => {
  it('returns null instead of throwing for a missing or foreign module', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-foreign-'))
    try {
      writeFileSync(join(scratch, 'not-an-addon.node'), 'plain text')
      expect(loadNativeProcessInfoFrom(join(scratch, 'missing.node'))).toBeNull()
      expect(loadNativeProcessInfoFrom(join(scratch, 'not-an-addon.node'))).toBeNull()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describeDarwin('native/proc-info-darwin against ps', () => {
  let scratch = ''
  let addon: NativeProcessInfo
  let terminalChild: ChildProcess | null = null

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-'))
    const output = join(scratch, 'orca-proc-info.node')
    execFileSync(
      process.execPath,
      ['config/scripts/build-proc-info-macos.mjs', '--single-arch', '--output', output],
      { stdio: 'inherit' }
    )
    const loaded = loadNativeProcessInfoFrom(output)
    expect(loaded).not.toBeNull()
    addon = loaded!
  }, 120_000)

  afterAll(() => {
    terminalChild?.kill('SIGKILL')
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reads this process and its parent with the columns ps prints', () => {
    const rows = new Map(addon.listProcesses().map((row) => [row.pid, row]))
    for (const pid of [process.pid, process.ppid]) {
      const native = rows.get(pid)
      const ps = psRow(pid)
      expect(native).toBeDefined()
      expect({
        ppid: native!.ppid,
        pgid: native!.pgid,
        tpgid: native!.tpgid,
        stat: jobControlBits(native!.stat),
        tty: native!.tty,
        startTime: native!.startTime.replace(/\s+/g, ' ')
      }).toEqual({ ...ps, stat: jobControlBits(ps.stat) })
    }
  })

  it('reads argv like ps -o command=, and the executable where argv is withheld', () => {
    const rows = new Map(addon.listProcessesWithCommands().map((row) => [row.pid, row]))
    const ps = execFileSync('ps', ['-o', 'command=', '-p', String(process.pid)], {
      encoding: 'utf8'
    }).trim()
    expect(rows.get(process.pid)?.command).toBe(ps)
    // launchd belongs to root: its argv is withheld, its executable path is not.
    expect(rows.get(1)).toMatchObject({ command: null, path: '/sbin/launchd', name: 'launchd' })
  })

  it('answers single-pid and cwd lookups without a table scan', () => {
    const row = addon.readProcess(process.pid)
    expect(row?.ppid).toBe(process.ppid)
    expect(addon.readProcess(2 ** 30)).toBeNull()
    expect(addon.readProcessCwd(process.pid)).toBe(realpathSync(process.cwd()))
    // launchd belongs to root: the kernel refuses, as it does lsof.
    expect(addon.readProcessCwd(1)).toBeNull()
  })

  it('lists one terminal with argv, as ps -t does', async () => {
    // script(1) gives `sleep` a fresh pseudo-terminal of its own.
    terminalChild = spawn('script', ['-q', '/dev/null', 'sleep', '30'], { stdio: 'ignore' })
    let sleeper: { pid: number; tty: string } | undefined
    for (let attempt = 0; attempt < 50 && !sleeper; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const row = addon
        .listProcesses()
        .find((candidate) => candidate.ppid === terminalChild?.pid && candidate.tty !== '??')
      sleeper = row ? { pid: row.pid, tty: row.tty } : undefined
    }
    expect(sleeper).toBeDefined()

    const rows = addon.listTerminalProcesses(sleeper!.tty)
    const psCommands = new Map(
      execFileSync('ps', ['-o', 'pid=,command=', '-t', sleeper!.tty], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
        .flatMap((match) => (match ? [[Number(match[1]), match[2]] as const] : []))
    )
    expect(rows?.find((row) => row.pid === sleeper!.pid)).toMatchObject({
      command: 'sleep 30',
      name: 'sleep'
    })
    for (const row of rows ?? []) {
      expect(row.command).toBe(psCommands.get(row.pid))
    }
    expect(addon.listTerminalProcesses('ttys99999')).toBeNull()
  })
})
