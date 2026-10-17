// A real daemon, launched through the real launch path by a stand-in for Pod main
// (__fixtures__/daemon-launch-parent.ts), observed through what macOS reports as each process's
// responsible process: the daemon's, its terminal shell's and a command's run in that terminal,
// before and after the parent dies.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DaemonClient } from './client'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/agent-launcher/install-agent-launcher.cjs')
const installAgentLauncher: unknown = Reflect.get(Object(installer), 'installAgentLauncher')
const PARENT = join(__dirname, '__fixtures__', 'daemon-launch-parent.ts')
const DAEMON_ENTRY = join(__dirname, 'daemon-entry.ts')
// Why Node and not the runner's Bun: the parent and its daemon run as they do in the app.
const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const NO_DISCLAIM_LINE =
  /^\[daemon\] pod-agent-launcher: \/usr\/sbin\/taskpolicy starts without its own responsibility \(responsibility_spawnattrs_setdisclaim is unavailable\)$/

// `responsible <pid>...` prints each pid's responsible pid; `responsible --report <file>` appends
// its own and its parent's (the shell that ran it).
const RESPONSIBLE_SOURCE = `#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int (*responsible)(int) = dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  if (!responsible) return 69;
  if (argc == 3 && strcmp(argv[1], "--report") == 0) {
    FILE *out = fopen(argv[2], "a");
    if (!out) return 73;
    fprintf(out, "{\\"pid\\":%d,\\"responsible\\":%d,\\"shell\\":%d,\\"shellResponsible\\":%d}\\n",
      getpid(), responsible(getpid()), getppid(), responsible(getppid()));
    return fclose(out) == 0 ? 0 : 74;
  }
  for (int i = 1; i < argc; i++) printf("%d\\n", responsible(atoi(argv[i])));
  return 0;
}
`
// Hides the disclaim symbol from a process that loads it, as a macOS without it would.
const NO_DISCLAIM_SOURCE = `#include <dlfcn.h>
#include <string.h>
static void *hidden_dlsym(void *handle, const char *symbol) {
  return strcmp(symbol, "responsibility_spawnattrs_setdisclaim") == 0 ? NULL : dlsym(handle, symbol);
}
__attribute__((used, section("__DATA,__interpose"))) static struct {
  const void *replacement; const void *replacee;
} interpose_dlsym = { (const void *)hidden_dlsym, (const void *)dlsym };
`

type TerminalReport = { pid: number; responsible: number; shell: number; shellResponsible: number }

type LaunchSetup = {
  /** Loaded into the daemon, as a macOS without the disclaim symbol would behave. */
  daemonDylib?: string
  /** The POD_AGENT_LAUNCHER_BINARY the daemon launch sees; null leaves it unset. */
  launcherBinary?: string | null
  killSwitch?: boolean
}

type Launch = {
  parent: ChildProcess
  parentPid: number
  daemonPid: number
  childPid: number
  stderr: () => string
  userData: string
  client: DaemonClient | null
  reports: number
}

let root = ''
let launcher = ''
let responsibleTool = ''
let noDisclaimDylib = ''
const launches: Launch[] = []

function compile(name: string, source: string, args: string[] = []): string {
  const sourcePath = join(root, `${name}.c`)
  const output = join(root, name)
  writeFileSync(sourcePath, source)
  const result = spawnSync('cc', ['-O2', ...args, '-o', output, sourcePath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`cc ${name}: ${result.stderr}`)
  }
  return output
}

function responsibleFor(pid: number): number {
  return Number(spawnSync(responsibleTool, [String(pid)], { encoding: 'utf8' }).stdout.trim())
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(what: string, read: () => T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The parent starts responsible for itself, as Pod main does (LaunchServices starts it). */
async function launchDaemon(disclaim: boolean, setup: LaunchSetup = {}): Promise<Launch> {
  const { daemonDylib, launcherBinary = launcher, killSwitch = false } = setup
  const userData = mkdtempSync(join(root, 'u-'))
  const tsx = pathToFileURL(require.resolve('tsx')).href
  const parent = spawn(
    launcher,
    [
      '--disclaim-exec',
      NODE,
      PARENT,
      userData,
      DAEMON_ENTRY,
      disclaim ? '1' : '0',
      ...(daemonDylib ? [daemonDylib] : [])
    ],
    {
      cwd: userData,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Why a bare env: nothing from the terminal running the tests (a live Pod's) reaches the daemon.
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: userData,
        // tsx keeps its compile cache there, so later launches skip the cold compile.
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        USER: process.env.USER ?? '',
        LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
        SHELL: '/bin/sh',
        ORCA_DIAGNOSTICS_DISABLED: '1',
        ...(launcherBinary ? { POD_AGENT_LAUNCHER_BINARY: launcherBinary } : {}),
        ...(killSwitch ? { POD_DAEMON_DISCLAIM: '0' } : {}),
        NODE_OPTIONS: `--import=${tsx} --conditions=orca-source`
      }
    }
  )
  let stdout = ''
  let stderr = ''
  parent.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
  parent.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const parentPid = parent.pid ?? 0
  const launch: Launch = {
    parent,
    parentPid,
    daemonPid: 0,
    childPid: 0,
    stderr: () => stderr,
    userData,
    client: null,
    reports: 0
  }
  launches.push(launch)
  const line = await waitFor(
    'the daemon pid',
    () => {
      if (parent.exitCode !== null) {
        throw new Error(`the parent exited ${parent.exitCode}: ${stderr}`)
      }
      return stdout.includes('\n') ? stdout.slice(0, stdout.indexOf('\n')) : null
    },
    70_000
  )
  const ready: unknown = JSON.parse(line)
  const daemonPid: unknown = Reflect.get(Object(ready), 'daemonPid')
  const childPid: unknown = Reflect.get(Object(ready), 'childPid')
  if (typeof daemonPid !== 'number' || typeof childPid !== 'number') {
    throw new Error(`no daemon pids in ${line}`)
  }
  launch.daemonPid = daemonPid
  launch.childPid = childPid
  return launch
}

/** Types a command into the daemon's terminal, as a user would, and reads what it reports. */
async function runInTerminal(launch: Launch): Promise<TerminalReport> {
  if (!launch.client) {
    launch.client = new DaemonClient({
      socketPath: join(launch.userData, 'd.sock'),
      tokenPath: join(launch.userData, 'd.token')
    })
    await launch.client.ensureConnected()
    await launch.client.request('createOrAttach', {
      sessionId: 'responsibility',
      cols: 80,
      rows: 24,
      cwd: launch.userData,
      shellOverride: '/bin/sh'
    })
  }
  const reportPath = join(launch.userData, `report-${++launch.reports}.json`)
  await launch.client.request('write', {
    sessionId: 'responsibility',
    data: `'${responsibleTool}' --report '${reportPath}'\n`
  })
  const text = await waitFor('the terminal report', () =>
    existsSync(reportPath) ? readFileSync(reportPath, 'utf8').trim() || null : null
  )
  const report: unknown = JSON.parse(text)
  const field = (name: keyof TerminalReport): number => Number(Reflect.get(Object(report), name))
  return {
    pid: field('pid'),
    responsible: field('responsible'),
    shell: field('shell'),
    shellResponsible: field('shellResponsible')
  }
}

async function killParent(launch: Launch): Promise<void> {
  if (launch.parent.exitCode === null && launch.parent.signalCode === null) {
    const exited = once(launch.parent, 'exit')
    launch.parent.kill('SIGKILL')
    await exited
  }
}

describe.skipIf(process.platform !== 'darwin')('the macOS daemon responsible for itself', () => {
  beforeAll(() => {
    // Why realpath and a short name: a Unix socket path must stay under 104 bytes.
    root = realpathSync(mkdtempSync('/tmp/pod-resp-'))
    mkdirSync(join(root, 'Resources', 'bin'), { recursive: true })
    if (typeof installAgentLauncher !== 'function') {
      throw new Error('install-agent-launcher.cjs exports no installAgentLauncher')
    }
    installAgentLauncher(join(root, 'Resources'), process.arch)
    launcher = join(root, 'Resources', 'bin', 'pod-agent-launcher')
    responsibleTool = compile('responsible', RESPONSIBLE_SOURCE)
    noDisclaimDylib = compile('no-disclaim.dylib', NO_DISCLAIM_SOURCE, ['-dynamiclib'])
  }, 180_000)

  afterEach(async () => {
    for (const launch of launches.splice(0)) {
      launch.client?.disconnect()
      await killParent(launch)
      if (launch.daemonPid > 0 && isAlive(launch.daemonPid)) {
        process.kill(launch.daemonPid, 'SIGTERM')
        await waitFor('the daemon to exit', () => (isAlive(launch.daemonPid) ? null : true))
      }
    }
  })

  afterAll(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the daemon and everything its terminals run attributed to the daemon after its parent dies', async () => {
    const launch = await launchDaemon(true)
    const { parentPid, daemonPid } = launch
    // The launcher and taskpolicy exec in place: the pid the launch spawned is the daemon's own.
    expect(launch.childPid).toBe(daemonPid)
    expect(responsibleFor(parentPid)).toBe(parentPid)
    expect(responsibleFor(daemonPid)).toBe(daemonPid)
    const before = await runInTerminal(launch)
    expect(before).toMatchObject({ responsible: daemonPid, shellResponsible: daemonPid })

    await killParent(launch)
    expect(isAlive(daemonPid)).toBe(true)
    expect(responsibleFor(daemonPid)).toBe(daemonPid)
    const after = await runInTerminal(launch)
    expect(after.shell).toBe(before.shell)
    expect(after).toMatchObject({ responsible: daemonPid, shellResponsible: daemonPid })
    expect(launch.stderr()).not.toContain('pod-agent-launcher')
  }, 150_000)

  // The bug this fixes, and what proves the test above can fail: a forked daemon is its parent's.
  it('without the disclaim, attributes everything to the parent, and to nobody once it dies', async () => {
    const launch = await launchDaemon(false)
    const { parentPid, daemonPid } = launch
    expect(responsibleFor(daemonPid)).toBe(parentPid)
    const before = await runInTerminal(launch)
    expect(before).toMatchObject({ responsible: parentPid, shellResponsible: parentPid })

    await killParent(launch)
    const after = await runInTerminal(launch)
    // macOS answers a dead responsible pid with the process itself.
    expect(after).toMatchObject({ responsible: after.pid, shellResponsible: after.shell })
  }, 150_000)

  it('starts the daemon as before, with one log line, where macOS has no disclaim', async () => {
    const launch = await launchDaemon(true, { daemonDylib: noDisclaimDylib })
    const { parentPid, daemonPid } = launch
    expect(launch.childPid).toBe(daemonPid)
    expect(responsibleFor(daemonPid)).toBe(parentPid)
    expect(await runInTerminal(launch)).toMatchObject({ shellResponsible: parentPid })
    const lines = launch
      .stderr()
      .split('\n')
      .filter((line) => line.includes('pod-agent-launcher'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(NO_DISCLAIM_LINE)
  }, 150_000)

  it('starts the daemon as before, with one warning, when there is no launcher', async () => {
    const launch = await launchDaemon(true, { launcherBinary: null })
    expect(responsibleFor(launch.daemonPid)).toBe(launch.parentPid)
    expect(launch.stderr().match(/\[daemon\] no pod-agent-launcher/g)).toHaveLength(1)
  }, 150_000)

  it('starts the daemon as before when the launcher is stale and exits 64', async () => {
    const stale = join(root, 'stale-launcher')
    writeFileSync(stale, '#!/bin/sh\nexit 64\n', { mode: 0o755 })
    const launch = await launchDaemon(true, { launcherBinary: stale })
    expect(isAlive(launch.daemonPid)).toBe(true)
    expect(responsibleFor(launch.daemonPid)).toBe(launch.parentPid)
    expect(launch.stderr()).toContain('retrying without it')
  }, 150_000)

  it("keeps today's attribution with POD_DAEMON_DISCLAIM=0", async () => {
    const launch = await launchDaemon(true, { killSwitch: true })
    expect(responsibleFor(launch.daemonPid)).toBe(launch.parentPid)
    expect(launch.stderr()).not.toContain('pod-agent-launcher')
  }, 150_000)
})
