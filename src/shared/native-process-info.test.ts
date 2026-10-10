import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as appEnvironment from './app-environment'
import {
  getNativeProcessInfo,
  loadNativeProcessInfoFrom,
  NATIVE_PROCESS_INFO_BUILD_PATH,
  NATIVE_PROCESS_INFO_RESOURCE_PATH,
  setNativeProcessInfoForTests,
  type NativeProcessInfoAddon
} from './native-process-info'

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
    // Why: the addon formats lstart like ps under a uniform en_US.UTF-8, whatever LANG says.
    { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'en_US.UTF-8' } }
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

describe.runIf(process.platform === 'darwin')('trusted native addon selection', () => {
  const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  // Pod: the full kernel-snapshot surface, so the addon passes the loader's shape check.
  const native: NativeProcessInfoAddon = {
    listProcesses: () => [],
    listProcessesWithCommands: () => [],
    readProcess: () => null,
    readProcessForegroundGroup: () => null,
    listTerminalProcesses: () => null,
    readProcessCwd: () => null
  }
  // Pod wraps the table reads in a snapshot worker, so compare the addon's own lookup.
  const loaded = () => getNativeProcessInfo()?.readProcessForegroundGroup
  let scratch = ''
  const hasEnvironment = () => vi.spyOn(appEnvironment, 'hasAppEnvironment')
  const loadAddon = () => vi.spyOn(process, 'dlopen')

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-selection-'))
    for (const relative of [NATIVE_PROCESS_INFO_BUILD_PATH, NATIVE_PROCESS_INFO_RESOURCE_PATH]) {
      mkdirSync(dirname(join(scratch, relative)), { recursive: true })
      writeFileSync(join(scratch, relative), 'fixture')
    }
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: scratch })
    vi.stubEnv('ORCA_DISABLE_NATIVE_PROCESS_INFO', '0')
    hasEnvironment().mockReturnValue(false)
    vi.spyOn(appEnvironment, 'getAppEnvironment').mockReturnValue({
      getAppPath: () => scratch,
      isPackaged: () => false,
      getPath: () => scratch,
      getVersion: () => 'fixture',
      getAppMetrics: () => [],
      onWillQuit: () => {},
      exit: () => {}
    })
    loadAddon().mockImplementation((module) => {
      Object.assign(module, { exports: native })
    })
    setNativeProcessInfoForTests(undefined)
  })

  afterEach(() => {
    setNativeProcessInfoForTests(undefined)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (resourcesDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  it('loads packaged resources before app initialization and caches the result', () => {
    writeFileSync(join(scratch, 'app.asar'), '')
    const first = getNativeProcessInfo()
    expect(loaded()).toBe(native.readProcessForegroundGroup)
    expect(getNativeProcessInfo()).toBe(first)
    const path = join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH)
    expect(loadAddon()).toHaveBeenCalledExactlyOnceWith(expect.anything(), path)
  })

  it.each(['missing', 'incompatible'])('caches a definitive packaged %s result', (mode) => {
    writeFileSync(join(scratch, 'app.asar'), '')
    if (mode === 'missing') {
      rmSync(join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH))
    } else {
      loadAddon().mockImplementationOnce(() => {
        throw new Error('incompatible architecture')
      })
    }
    expect(getNativeProcessInfo()).toBeNull()
    writeFileSync(join(scratch, NATIVE_PROCESS_INFO_RESOURCE_PATH), 'repaired fixture')
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1)
  })

  it('does not probe cwd and retries only after an explicit development environment appears', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(scratch)
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).not.toHaveBeenCalled()
    hasEnvironment().mockReturnValue(true)
    expect(loaded()).toBe(native.readProcessForegroundGroup)
    const path = join(scratch, NATIVE_PROCESS_INFO_BUILD_PATH)
    expect(loadAddon()).toHaveBeenCalledExactlyOnceWith(expect.anything(), path)
  })

  it('never probes the development path for a packaged environment without resources', () => {
    hasEnvironment().mockReturnValue(true)
    vi.spyOn(appEnvironment.getAppEnvironment(), 'isPackaged').mockReturnValue(true)
    expect(getNativeProcessInfo()).toBeNull()
    expect(loadAddon()).not.toHaveBeenCalled()
  })
})

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
  let addonPath = ''
  let addon: NativeProcessInfoAddon
  let terminalChild: ChildProcess | null = null

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-proc-info-'))
    addonPath = join(scratch, 'orca-proc-info.node')
    execFileSync(
      process.execPath,
      ['config/scripts/build-proc-info-macos.mjs', '--single-arch', '--output', addonPath],
      { stdio: 'inherit' }
    )
    const loaded = loadNativeProcessInfoFrom(addonPath)
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
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
    }).trim()
    expect(rows.get(process.pid)?.command).toBe(ps)
    // launchd belongs to root: its argv is withheld, its executable path is not.
    expect(rows.get(1)).toMatchObject({ command: null, path: '/sbin/launchd', name: 'launchd' })
  })

  it('matches ps for empty arguments, control characters and Unicode', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
        '',
        'spaces  between',
        'café 日本 🙂',
        'line\nbreak',
        'tab\tvalue',
        'return\rvalue',
        'escape\u001bvalue',
        'delete\u007fvalue',
        'c1\u0085value',
        'slash\\value',
        ''
      ],
      { stdio: 'ignore' }
    )
    try {
      await once(child, 'spawn')
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('test child has no pid')
      }
      const native = addon.listProcessesWithCommands().find((row) => row.pid === pid)
      const ps = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
      }).trim()
      expect(native?.command).toBe(ps)
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, 2 ** 32 + 1, -(2 ** 32) + 1])(
    'rejects invalid pid %s without truncating or wrapping',
    (pid) => {
      expect(() => addon.readProcess(pid)).toThrow('expected a positive pid')
      expect(() => addon.readProcessCwd(pid)).toThrow('expected a positive pid')
      expect(() => addon.readProcessForegroundGroup(pid, 'ttys003')).toThrow(
        'expected a positive pid'
      )
    }
  )

  it.each(['', 'x'.repeat(255), 'ttys003\u0000ignored'])(
    'rejects invalid terminal name %j without truncating it',
    (tty) => {
      expect(() => addon.listTerminalProcesses(tty)).toThrow('expected a terminal name')
      expect(() => addon.readProcess(process.pid, tty)).toThrow('expected a terminal name')
    }
  )

  it.each([
    '',
    'x'.repeat(1024),
    'ttys003\u0000ignored',
    '../tmp',
    '/dev/../tmp',
    '/tmp/tty',
    '/dev/',
    '.',
    '..',
    'pts/3',
    '/dev/fd/0'
  ])('rejects foreground terminal %j before checking a missing process', (name) =>
    expect(() => addon.readProcessForegroundGroup(2 ** 30, name)).toThrow(
      'expected a terminal name'
    )
  )

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
      const line = execFileSync('ps', ['-axo', 'pid=,ppid=,tty='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((row) => Number(row[1]) === terminalChild?.pid && row[2] !== '??')
      sleeper = line ? { pid: Number(line[0]), tty: line[2] } : undefined
    }
    expect(sleeper).toBeDefined()

    const workers = Array.from(
      { length: 2 },
      () =>
        new Worker(
          `
            const { parentPort, workerData } = require('node:worker_threads')
            const addon = require(workerData.path)
            parentPort.once('message', () => {
              const foreground = addon.readProcessForegroundGroup(workerData.pid, workerData.tty)
              let coldCode
              try {
                addon.readProcess(workerData.pid)
              } catch (error) {
                coldCode = error.code
              }
              const member = addon.readProcess(workerData.pid, workerData.tty)
              const foreign = addon.readProcess(workerData.pid, 'ttys99999')
              const captured = addon.listProcesses().find(row => row.pid === workerData.pid)
              const cached = addon.readProcess(workerData.pid)
              const rows = addon.listTerminalProcesses(workerData.tty)
              parentPort.postMessage({
                foregroundTty: foreground.tty,
                coldCode,
                memberTty: member.tty,
                foreignTty: foreign.tty,
                capturedTty: captured.tty,
                cachedTty: cached.tty,
                argvMatches: rows.some(row =>
                  row.pid === workerData.pid && row.tty === workerData.tty &&
                  row.command === 'sleep 30'
                )
              })
              parentPort.close()
            })
            parentPort.postMessage('ready')
          `,
          { eval: true, workerData: { path: addonPath, ...sleeper } }
        )
    )
    let rows: ReturnType<NativeProcessInfoAddon['listTerminalProcesses']>
    try {
      expect(await Promise.all(workers.map((worker) => once(worker, 'message')))).toEqual([
        ['ready'],
        ['ready']
      ])
      const results = workers.map((worker) => once(worker, 'message'))
      workers.forEach((worker) => worker.postMessage('read'))
      rows = addon.listTerminalProcesses(sleeper!.tty)
      expect(addon.readProcess(sleeper!.pid, sleeper!.tty)?.tty).toBe(sleeper!.tty)
      expect(addon.readProcess(sleeper!.pid, 'ttys99999')?.tty).toBe('??')
      expect(addon.readProcess(sleeper!.pid, `/dev/${sleeper!.tty}`)?.tty).toBe(sleeper!.tty)
      const [psPid, psTpgid, psTty] = execFileSync(
        'ps',
        ['-p', String(sleeper!.pid), '-o', 'pid=,tpgid=,tty='],
        { encoding: 'utf8' }
      )
        .trim()
        .split(/\s+/)
      expect(addon.readProcessForegroundGroup(sleeper!.pid, `/dev/${sleeper!.tty}`)).toEqual({
        pid: Number(psPid),
        tpgid: Number(psTpgid),
        tty: psTty
      })
      expect(addon.readProcessForegroundGroup(sleeper!.pid, '/dev/null')?.tty).toBe('??')
      expect(addon.readProcessForegroundGroup(sleeper!.pid, 'ttys99999')?.tty).toBe('??')
      expect(addon.readProcessForegroundGroup(process.pid, sleeper!.tty)?.tty).toBe('??')
      expect(addon.readProcessForegroundGroup(2 ** 30, sleeper!.tty)).toBeNull()
      for (const [result] of await Promise.all(results)) {
        expect(result).toEqual({
          // The resize lookup checks the device itself, so it needs no warm name cache.
          foregroundTty: sleeper!.tty,
          coldCode: 'ORCA_PROC_INFO_TTY_UNKNOWN',
          memberTty: sleeper!.tty,
          foreignTty: '??',
          capturedTty: sleeper!.tty,
          cachedTty: sleeper!.tty,
          argvMatches: true
        })
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()))
    }
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
