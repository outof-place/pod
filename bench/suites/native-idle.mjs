// Pod 1.0's idle cost with its native UI: CPU, wakeups and memory of PodNative, its runtime and
// the terminal daemon while nothing happens, with 0, 1 and 8 idle terminals, then after the 8
// are closed through Close Terminals (worktree.sleep).
//
// PodNative runs as `--background`: its window is laid out and drawn but never ordered in, so
// nothing shows on screen. That is neither a visible window nor a closed one: git and the tab
// snapshots treat the window as on screen, the status bar as hidden (main.swift). Rows say so.
// Variants: acc-on (the default: claude-acc's state read, here a stub state rewritten at
// claude-acc's live rates) and acc-off (POD_NATIVE_NO_ACC=1), as a breakdown.
//
//   node bench/suites/native-idle.mjs [--launches 2] [--variants acc-on,acc-off]
//        [--warmup-s 60] [--settle-s 30] [--window-s 300]
//
// Each launch: an APFS clone of the re-id'd one-app bundle (codes.pod.native.e2e /
// codes.pod.runtime.e2e), a fresh profile and HOME under its own /private/tmp dir, PodNative's
// app_open (scripts/open-app.sh at the guard's revision: `open -n -g -W` under `env -i` with an
// allowlist, the launchd session's SSH_AUTH_SOCK, USER, LOGNAME and DISPLAY empty), the same
// allowlist for the runtime through --runtime-env, a guard PATH whose agents are stubs and whose
// security is the gate-2 shim. The caller's canary (GUARD_CANARY_TOKEN) must reach no process of
// the launch, and PodNative and its runtime must show GUARD_POSITIVE_MARK, which app_open adds
// (guard-path.sh guard_env_pid_check, names only; the stubs' log too). Every second a watchdog
// checks the run's processes: a real claude or codex, or a new SecurityAgent, stops the launch.
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { checkAcc, guardInstance, releaseInstance } from '../lib/acc-guard.mjs'
import { assertHeavyGate } from '../lib/heavy-gate.mjs'
import {
  APP_ENV_BLANK,
  envTreeCheck,
  guardVerdict,
  installedClaudeVersion,
  prepareGuard,
  spawnAppOpen
} from '../lib/guard-path.mjs'
import { assertRealHomeUntouched, realHomeState } from '../lib/real-home-guard.mjs'
import {
  MAX_LOAD,
  loadAverage,
  log,
  sleep,
  waitForQuiet,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { POD_OUTER_APP, describeApp } from '../lib/orca-instance.mjs'
import { rpcOk, runtimeMeta } from '../lib/runtime-rpc.mjs'
import { runTree, stopRunTree } from '../lib/run-tree.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const run = promisify(execFile)
const { values: options } = parseArgs({
  options: {
    launches: { type: 'string', default: '2' },
    variants: { type: 'string', default: 'acc-on,acc-off' },
    'warmup-s': { type: 'string', default: '60' },
    'settle-s': { type: 'string', default: '30' },
    'window-s': { type: 'string', default: '300' }
  }
})
const launches = Number(options.launches)
const variants = options.variants.split(',')
const warmupS = Number(options['warmup-s'])
const settleS = Number(options['settle-s'])
const windowS = Number(options['window-s'])
const SUITE = 'native-idle'
const HOME = os.homedir()
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
// The PodNative revision whose harness files (security shim, claude-acc stub state) the run uses.
const PODNATIVE_REPO = path.join(HOME, 'Documents/orca-native-wt/native-ui/PodNative')

// The states, in the order one launch goes through them.
const STATES = [
  { id: 'idle0', label: 'no terminal', terminals: 0 },
  { id: 'idle1', label: '1 idle terminal', terminals: 1 },
  { id: 'idle8', label: '8 idle terminals', terminals: 8 },
  { id: 'sleep8', label: 'the 8 terminals closed (Close Terminals)', terminals: 0, sleep: true }
]

const outer = realpathSync(POD_OUTER_APP)
const outerInfo = describeApp(outer)
const ids = {
  outer: plist(path.join(outer, 'Contents/Info.plist'), 'CFBundleIdentifier'),
  runtime: plist(path.join(outer, 'Contents/Helpers/Pod Runtime.app/Contents/Info.plist'), 'CFBundleIdentifier')
}
if (ids.outer !== 'codes.pod.native.e2e' || ids.runtime !== 'codes.pod.runtime.e2e') {
  throw new Error(`refusing: the one-app bundle must be a re-id'd clone (outer ${ids.outer}, runtime ${ids.runtime})`)
}
const podNativeRevision = plist(path.join(outer, 'Contents/Info.plist'), 'PodNativeRevision')

function plist(file, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim()
}

function podNativeFile(rel) {
  return execFileSync('git', ['-C', PODNATIVE_REPO, 'show', `${podNativeRevision}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 16 << 20
  })
}

const PROTECTED = ['/Applications/', path.join(HOME, 'Library/Application Support/Pod/')]
// An app LaunchServices starts gets the launchd session's environment beside what `open --env`
// gives it: none of these may be set there.
const SESSION_ENV = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ORCA_USER_DATA_PATH',
  'POD_USER_DATA_PATH',
  'ORCA_E2E_USER_DATA_DIR',
  'POD_E2E_USER_DATA_DIR',
  'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES'
]
const sessionEnv = SESSION_ENV.filter((name) => {
  try {
    return execFileSync('/bin/launchctl', ['getenv', name], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
})
if (sessionEnv.length > 0) {
  throw new Error(`refusing: the launchd session sets ${sessionEnv.join(', ')}, which an app started through LaunchServices would get`)
}
const DOMAINS = ['codes.pod.native', 'codes.pod.app', 'codes.pod.native.e2e', 'codes.pod.runtime.e2e']
// The domain as `defaults export` writes it (XML: some values have no JSON form).
function domainKeys(domain) {
  try {
    return execFileSync('/usr/bin/defaults', ['export', domain, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}
function securityAgents() {
  try {
    return execFileSync('/usr/bin/pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** A launch's directory: the clone, the profile and HOME, the guard PATH, the stub claude-acc state. */
function prepare(variant) {
  const work = realpathSync(mkdtempSync('/private/tmp/pbn.'))
  const app = path.join(work, 'Pod.app')
  execFileSync('/bin/cp', ['-c', '-R', outer, app])
  // A quarantined clone would make `open` show a Gatekeeper dialog: this run's own clone only.
  execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app])
  const profile = path.join(work, 'profile')
  const home = path.join(profile, 'home')
  const guard = path.join(work, 'guard')
  for (const dir of [profile, home, path.join(profile, 'tmp'), path.join(profile, 'bin'), guard, path.join(work, 'out')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // The gate-2 security shim goes in front of the guard PATH (lib/guard-path.mjs), whose stubs
  // stand for every agent and credential CLI Pod's catalog probes, first in every shell of HOME.
  writeFileSync(path.join(guard, 'security'), podNativeFile('scripts/claude-tui/security_shim.sh'), { mode: 0o700 })
  const guardSetup = prepareGuard(work, { ud: profile, homes: [home], fronts: [guard], tree: app, claudeVersion: installedClaudeVersion() })
  writeFileSync(path.join(home, '.hushlogin'), '')
  // A repo for the terminals: a plain one-commit git repo.
  const repo = path.join(work, 'repo')
  mkdirSync(repo)
  writeFileSync(path.join(repo, 'README.md'), '# bench\n')
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
  let accHome = null
  if (variant === 'acc-on') {
    accHome = path.join(work, 'acc')
    const state = path.join(accHome, '.local/share/claude-acc')
    if (path.resolve(state) === path.join(HOME, '.local/share/claude-acc')) {
      throw new Error('refusing: that is the account\'s own claude-acc state')
    }
    stubAccState(state)
  }
  return { work, app, exe: path.join(app, 'Contents/MacOS/PodNative'), profile, home, guard, guardSetup, repo, accHome }
}

// PodNative's mac-e2e claude-acc fixtures (scripts/mac-e2e/state), moved to this run's clock, with
// its stand-in interpreter, as scripts/mac-e2e/run.sh sets them up.
function stubAccState(state) {
  const listing = execFileSync('git', ['-C', PODNATIVE_REPO, 'ls-tree', '-r', '--name-only', podNativeRevision, 'scripts/mac-e2e/state'], {
    encoding: 'utf8'
  })
  const delta = Date.now() / 1000 - 1760000000
  const shift = (value) =>
    Array.isArray(value)
      ? value.map(shift)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v)]))
        : typeof value === 'number' && value >= 1759000000 && value <= 1761000000
          ? value + delta
          : value
  for (const rel of listing.split('\n').filter(Boolean)) {
    const target = path.join(state, path.relative('scripts/mac-e2e/state', rel))
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const text = podNativeFile(rel)
    writeFileSync(target, rel.endsWith('.json') ? `${JSON.stringify(shift(JSON.parse(text)), null, 1)}\n` : text)
  }
  writeFileSync(path.join(state, 'python'), podNativeFile('scripts/mac-e2e/stub-acc.py'), { mode: 0o755 })
  writeFileSync(path.join(state, 'acc.py'), '')
  writeFileSync(path.join(state, '..', 'live-writer.py'), podNativeFile('scripts/mac-e2e/live-writer.py'))
}

/**
 * The launch's processes with their rusage: every process whose executable lies inside the run's
 * dir (the clone's PodNative and runtime helpers, the daemon the runtime copies into the profile)
 * and their descendants, the terminals' shells among them. `scan` also lists processes whose argv
 * merely names the run's dir (via "argv"): those are reported, never counted or signalled, since
 * anyone's `tail` of a log there would match.
 */
function snapshot(launch, { scan = false } = {}) {
  return runTree(launch.work, { scan, exclude: harness })
}
// The harness's own processes that name the run's dir: the shell that runs app_open, `open -W`
// and the stub state's writer.
const openers = new Set()
function harness(proc) {
  return openers.has(proc.pid) || proc.path === '/usr/bin/open' || proc.args.includes('live-writer.py')
}

// What each process is, by its executable: Pod's own (inside the clone) or the terminals' workload.
function classify(launch, proc) {
  const exe = proc.path
  if (exe === launch.exe) {
    return 'podnative'
  }
  // The runtime starts the terminal daemon from a copy of itself in the profile.
  if (exe.startsWith(`${launch.profile}/daemon-host.noindex/`)) {
    return 'daemon'
  }
  if (!exe.startsWith(`${launch.app}/`)) {
    return 'workload'
  }
  const name = path.basename(exe)
  if (/Helper \(GPU\)/.test(name)) {
    return 'runtime-gpu'
  }
  if (/Helper \(Renderer\)/.test(name)) {
    return 'runtime-renderer'
  }
  if (/Helper/.test(name)) {
    return 'runtime-helper'
  }
  if (/crashpad/.test(name)) {
    return 'crashpad'
  }
  if (exe.includes('/Pod Runtime.app/Contents/MacOS/')) {
    return /daemon/.test(proc.args) ? 'daemon' : 'runtime-main'
  }
  return 'bundle-other'
}

// A real agent binary in the run's tree: the account's claude (versions dir) or any claude/codex
// that is not one of the guard's stubs.
function realAgent(launch, proc) {
  const base = path.basename(proc.path)
  if (proc.path.startsWith(path.join(HOME, '.local/share/claude/'))) {
    return true
  }
  return (base === 'claude' || base === 'codex') && !proc.path.startsWith(`${launch.guard}/`)
}

function rates(before, after, seconds, launch) {
  const prior = new Map(before.procs.map((proc) => [proc.pid, proc]))
  const classes = {}
  for (const proc of after.procs) {
    const kind = classify(launch, proc)
    const was = prior.get(proc.pid)
    const entry = (classes[kind] ??= { processes: 0, cpuMsPerS: 0, wakeupsPerS: 0, footprintMiB: 0 })
    entry.processes += 1
    // A process born inside the window counts all it used.
    entry.cpuMsPerS += (proc.cpuNs - (was?.cpuNs ?? 0)) / 1e6 / seconds
    entry.wakeupsPerS += (proc.interruptWakeups + proc.idleWakeups - ((was?.interruptWakeups ?? 0) + (was?.idleWakeups ?? 0))) / seconds
    entry.footprintMiB += proc.footprint / 2 ** 20
  }
  const pod = Object.entries(classes).filter(([kind]) => kind !== 'workload')
  const sum = (field) => pod.reduce((total, [, entry]) => total + entry[field], 0)
  const gone = before.procs.filter((proc) => !after.procs.some((next) => next.pid === proc.pid)).length
  return { cpuMsPerS: sum('cpuMsPerS'), wakeupsPerS: sum('wakeupsPerS'), footprintMiB: sum('footprintMiB'), processes: sum('processes'), gone, classes }
}

async function rpcWithRetry(launch, method, params, attempts = 20) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rpcOk(runtimeMeta({ ud: launch.profile }), method, params, 60_000)
    } catch (error) {
      if (attempt >= attempts) {
        throw error
      }
      await sleep(1_000)
    }
  }
}

async function measureLaunch(variant, index) {
  const launch = prepare(variant)
  log(`${SUITE}: launch ${index + 1} (${variant}) in ${launch.work}`)
  const realBefore = realHomeState()
  const domainsBefore = Object.fromEntries(DOMAINS.map((domain) => [domain, domainKeys(domain)]))
  const agentsBefore = securityAgents()
  // PodNative quits (and quits its runtime over the control channel) when its own idle window ends.
  const totalS = warmupS + STATES.length * (settleS + windowS) + 90
  const guardPath = launch.guardSetup.path
  const guardEnv = Object.entries(launch.guardSetup.env)
  const nosearch = path.join(launch.profile, 'tmp/no-ogd.sock')
  const env = (flag, pairs) => pairs.flatMap(([key, value]) => [flag, `${key}=${value}`])
  // PodNative opens its runtime with `open --env` and its own environment, and LaunchServices adds
  // the session's variables again: the runtime gets app_open's allowlist and blanks explicitly.
  // Never GUARD_POSITIVE_MARK here: these words are PodNative's argv, which `ps -E` shows too, so
  // the runtime's mark must come through its environment alone.
  const runtimeEnv = env('--runtime-env', [
    ...APP_ENV_BLANK.map((name) => [name, '']),
    ['TMPDIR', path.join(launch.work, 't')],
    ['SHELL', '/bin/zsh'],
    ['LANG', 'en_US.UTF-8'],
    ['ORCA_E2E_USER_DATA_DIR', launch.profile],
    ['POD_E2E_USER_DATA_DIR', launch.profile],
    ['ORCA_E2E_HOME_DIR', launch.home],
    ['ORCA_BACKGROUND_LAUNCH', '1'],
    ['POD_BACKGROUND_LAUNCH', '1'],
    ['ORCA_DISABLE_MACOS_LOGIN_SHELL', '1'],
    ['ORCA_CLI_INSTALL_PATH', path.join(launch.profile, 'bin/orca')],
    ['HOME', launch.home],
    ['POD_ACC_LIFECYCLE', 'off'],
    ['PATH', guardPath],
    ['POD_SEARCH_SOCKET', nosearch],
    ...guardEnv
  ])
  const report = path.join(launch.work, 'out/measure.json')
  // app_open <bundle> <log> --front <shim dir> --env…: HOME, PATH (the guard PATH, the shim's dir
  // first), TMPDIR (<run dir>/t), SHELL, LANG and __CF_USER_TEXT_ENCODING, the blanks,
  // GUARD_POSITIVE_MARK=1, then these --env; stdout and stderr both into the log.
  const args = [
    launch.app,
    path.join(launch.work, 'out/podnative.log'),
    '--front',
    launch.guard,
    ...env('--env', [
      ['HOME', launch.home],
      ['PATH', guardPath],
      ['LANG', 'en_US.UTF-8'],
      ['POD_SEARCH_SOCKET', nosearch],
      ...guardEnv,
      ...(variant === 'acc-off' ? [['POD_NATIVE_NO_ACC', '1']] : [])
    ]),
    '--args',
    '--background',
    '--measure',
    report,
    '--idle-seconds',
    String(totalS),
    '--keys',
    '0',
    '--profile',
    launch.profile,
    '--runtime-arg',
    '--password-store=basic',
    '--runtime-arg',
    '--use-mock-keychain',
    '--runtime-arg',
    '--no-pairing',
    ...runtimeEnv,
    ...(launch.accHome ? ['--acc-home', launch.accHome] : []),
    '-oneAppClassicRuntime',
    'NO'
  ]
  let writer = null
  if (launch.accHome) {
    // claude-acc's live write rates on the stub state (mac-e2e live-writer.py), for the whole launch.
    const state = path.join(launch.accHome, '.local/share/claude-acc')
    // A harness process (harness() keeps it out of every snapshot), with an env of its own: never
    // this process's, which carries the caller's canary.
    writer = spawn('/usr/bin/python3', ['-I', path.join(state, '..', 'live-writer.py'), state, String(totalS + 60)], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'ignore'
    })
  }
  const launchedAt = Date.now()
  // app_open (lib/guard-path.mjs spawnAppOpen) in a shell that starts from callerEnv(), the canary
  // in it; app_open runs open under its own `env -i`, and the shell waits for open (alive while
  // PodNative is). app_open's own refusals land in out/opener.log.
  const opener = spawnAppOpen(launch.work, args, { stderrFile: path.join(launch.work, 'out/opener.log') })
  openers.add(opener.pid)
  let openerStatus = null
  const openerExit = new Promise((resolve) => opener.on('exit', (code) => resolve((openerStatus = code))))
  const envChecks = []
  // PodNative and its runtime must show the mark and no canary; no other process of the launch may
  // show the canary, and one that shows no mark either (zsh, a platform binary) is listed unproven.
  const checkEnv = async (when, launched) => {
    const verdict = envTreeCheck(launch.work, (await snapshot(launch)).procs, {
      launched,
      labelOf: (proc) => classify(launch, proc)
    })
    envChecks.push({ when, ...verdict })
    if (!verdict.ok) {
      throw new Error(`env allowlist (${when}): ${verdict.problems.join('; ')}`)
    }
  }
  let failure = null
  const stop = async (reason) => {
    failure ??= reason
    log(`${SUITE}: STOP ${reason}`)
    for (const proc of (await snapshot(launch)).procs) {
      if (proc.path === launch.exe) {
        process.kill(proc.pid, 'SIGTERM')
      }
    }
  }
  // The watchdog, every second until PodNative is gone.
  let watching = false
  const watchdog = setInterval(async () => {
    if (watching) {
      return
    }
    watching = true
    try {
      const now = await snapshot(launch)
      const offenders = now.procs.filter((proc) => realAgent(launch, proc))
      for (const proc of offenders) {
        process.kill(proc.pid, 'SIGKILL')
      }
      if (offenders.length > 0) {
        await stop(`a real agent in the run: ${offenders.map((proc) => `${proc.pid} ${proc.path}`).join(', ')}`)
      }
      const fresh = securityAgents().filter((pid) => !agentsBefore.includes(pid))
      if (fresh.length > 0) {
        await stop(`SecurityAgent ${fresh.join(' ')} appeared`)
      }
    } catch {
      // A snapshot that failed mid-run: the next tick reads again.
    } finally {
      watching = false
    }
  }, 1_000)
  const windows = []
  let guarded = null
  try {
    let pn = null
    for (let i = 0; i < 80 && !pn; i += 1) {
      pn = (await snapshot(launch)).procs.find((proc) => proc.path === launch.exe)?.pid ?? null
      if (!pn) {
        await sleep(250)
      }
    }
    if (!pn) {
      throw new Error(`no PodNative of this launch came up${openerStatus === null ? '' : ` (app_open's shell exited ${openerStatus}, out/opener.log)`}`)
    }
    // A claude-acc setup.sh anywhere stops the launch (lib/acc-guard.mjs).
    guardInstance(pn, () => process.kill(pn, 'SIGTERM'))
    guarded = pn
    const status = await rpcWithRetry(launch, 'status.get', undefined, 60)
    const runtimePid = JSON.parse(readFileSync(path.join(launch.profile, 'orca-runtime.json'), 'utf8')).pid
    const tree = await snapshot(launch)
    if (!tree.procs.some((proc) => proc.pid === runtimePid)) {
      throw new Error(`the runtime ${runtimePid} named by the profile is not this launch's`)
    }
    // Only loopback listeners.
    try {
      const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', tree.procs.map((proc) => proc.pid).join(','), '-iTCP', '-sTCP:LISTEN'])
      const wide = stdout.split('\n').slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/)[8]).filter((addr) => addr && !/^(127\.0\.0\.1|\[::1\]):/.test(addr))
      if (wide.length > 0) {
        throw new Error(`listens beyond loopback: ${wide.join(' ')}`)
      }
    } catch (error) {
      if (/beyond loopback/.test(error.message)) {
        throw error
      }
    }
    await checkEnv('runtime up', { [pn]: 'podnative', [runtimePid]: 'runtime' })
    await rpcWithRetry(launch, 'repo.add', { path: launch.repo })
    log(`${SUITE}: runtime ${runtimePid} up (${status.ms.toFixed(0)} ms), warming up ${warmupS} s`)
    await sleep(warmupS * 1000)
    let terminals = 0
    for (const state of STATES) {
      if (state.sleep) {
        await rpcWithRetry(launch, 'worktree.sleep', { worktree: `path:${launch.repo}` })
      }
      while (terminals < state.terminals) {
        await rpcWithRetry(launch, 'terminal.create', { worktree: `path:${launch.repo}`, focus: false })
        terminals += 1
      }
      // With the most processes: the 8 terminals' shells too, read before the settle.
      if (state.id === 'idle8') {
        await checkEnv('8 terminals', { [pn]: 'podnative', [runtimePid]: 'runtime' })
      }
      if (state.sleep) {
        terminals = 0
      }
      if (state.id !== 'idle0') {
        await sleep(settleS * 1000)
      }
      if (failure) {
        break
      }
      const loadBefore = loadAverage()
      const before = await snapshot(launch, { scan: true })
      const t0 = Date.now()
      await sleep(windowS * 1000)
      const after = await snapshot(launch, { scan: true })
      const seconds = (after.atMs - before.atMs) / 1000
      const loadAfter = loadAverage()
      windows.push({
        state: state.id,
        startEpochMs: before.atMs,
        endEpochMs: after.atMs,
        seconds,
        loadBefore,
        loadAfter,
        loadOk: loadBefore[0] <= MAX_LOAD,
        hostBusyCores: (after.hostBusyNs - before.hostBusyNs) / 1e9 / seconds,
        ...rates(before, after, seconds, launch),
        startedLateMs: Date.now() - t0 - windowS * 1000
      })
      log(`${SUITE}: ${variant} ${state.id} ${JSON.stringify(windows.at(-1)).slice(0, 200)}`)
    }
  } catch (error) {
    failure ??= error.message
    await stop(failure)
  }
  // PodNative ends its own idle window and quits; past its deadline it gets SIGTERM.
  const deadline = setTimeout(
    () => void stop('past the launch deadline'),
    Math.max(0, launchedAt + (totalS + 120) * 1000 - Date.now())
  )
  await openerExit
  clearTimeout(deadline)
  clearInterval(watchdog)
  openers.delete(opener.pid)
  if (guarded) {
    releaseInstance(guarded)
  }
  writer?.kill('SIGTERM')
  const cleaned = await cleanup(launch)
  const measure = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null
  const security = existsSync(path.join(launch.work, 'security.jsonl'))
    ? readFileSync(path.join(launch.work, 'security.jsonl'), 'utf8').split('\n').filter(Boolean)
    : []
  let realHome = null
  try {
    realHome = { sameContentRewrites: assertRealHomeUntouched(realBefore, 'during the launch', launch.work) }
  } catch (error) {
    realHome = { error: error.message }
    failure ??= error.message
  }
  const checks = {
    realHome,
    domainsChanged: DOMAINS.filter((domain) => domainKeys(domain) !== domainsBefore[domain]),
    securityCalls: security.length,
    securityNonFind: security.filter((line) => !/"subcommand": "find-/.test(line)).length,
    stubCalls: readFileSync(path.join(launch.work, 'guard-agents.log'), 'utf8').split('\n').filter(Boolean),
    guard: guardVerdict(launch.work, launch.guardSetup.fronts),
    env: envChecks,
    signalled: cleaned.signalled,
    leftovers: cleaned.left,
    argvOnly: cleaned.argvOnly,
    measureIdle: measure?.idle ?? null
  }
  checkAcc(`after native-idle launch ${index + 1}`)
  if (checks.securityNonFind > 0) {
    failure ??= `security shim saw ${checks.securityNonFind} non-find calls`
  }
  if (!checks.guard.ok) {
    failure ??= `guard PATH: ${checks.guard.problems.join('; ')}`
  }
  if (envChecks.length < 2 && !failure) {
    failure = `env allowlist checked ${envChecks.length} times, not 2`
  }
  log(`${SUITE}: launch ${index + 1} done${failure ? `, FAILED: ${failure}` : ''}; checks ${JSON.stringify({ ...checks, measureIdle: undefined }).slice(0, 300)}`)
  return { variant, launch: index, work: launch.work, failure, windows, checks }
}

/**
 * Stops whatever of the launch still runs: only processes whose executable lies inside the run's
 * dir and their descendants, never one that merely names the dir in its argv (reported instead),
 * never a program under /Applications or Pod's data. Returns every signal sent, and what was left.
 */
async function cleanup(launch) {
  const { signalled, left, argvOnly } = await stopRunTree(launch.work, { protectedPrefixes: PROTECTED, exclude: harness })
  const nested = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) {
          nested.push(full)
        }
        if (!entry.isSymbolicLink()) {
          walk(full)
        }
      }
    }
  }
  walk(path.join(launch.app, 'Contents'))
  for (const bundle of [...nested, launch.app]) {
    try {
      execFileSync(LSREGISTER, ['-u', bundle], { stdio: 'ignore' })
    } catch {}
  }
  return { signalled, left, argvOnly }
}

// The claude-acc baseline before the first launch (run-final.sh records one; a lone run takes it now).
checkAcc('before native-idle')
const results = []
for (let index = 0; index < launches * variants.length; index += 1) {
  const variant = variants[(index + Math.floor(index / variants.length)) % variants.length]
  const gate = await waitForQuiet()
  assertHeavyGate(`native-idle launch ${index + 1}`)
  const result = await measureLaunch(variant, index)
  results.push({ ...result, loadAtStart: gate.load })
}

const metrics = []
for (const variant of variants) {
  for (const state of STATES) {
    const kept = results
      .filter((result) => result.variant === variant && !result.failure)
      .flatMap((result) => result.windows.filter((window) => window.state === state.id && window.loadOk))
    const suffix = variant === 'acc-on' ? 'pod' : `pod-${variant}`
    const subject = `Pod ${outerInfo.version} (PodNative --background, ${variant === 'acc-on' ? 'claude-acc state read' : 'claude-acc off'})`
    const conditions = `${state.label}; ${windowS} s windows after ${state.id === 'idle0' ? `a ${warmupS} s warmup` : `${settleS} s to settle`}; PodNative + runtime + daemon, the terminals' shells excluded`
    const breakdown = Object.fromEntries(
      [...new Set(kept.flatMap((window) => Object.keys(window.classes)))].map((kind) => [
        kind,
        {
          cpuMsPerS: summarize(kept.map((window) => window.classes[kind]?.cpuMsPerS ?? 0), 'ms/s'),
          footprintMiB: summarize(kept.map((window) => window.classes[kind]?.footprintMiB ?? 0), 'MiB')
        }
      ])
    )
    metrics.push(
      { id: `${SUITE}.${state.id}.cpu.${suffix}`, subject, metric: `idle CPU, ${state.label}`, unit: 'ms/s', better: 'lower', stats: summarize(kept.map((w) => w.cpuMsPerS), 'ms/s'), conditions, extra: { breakdown } },
      { id: `${SUITE}.${state.id}.wakeups.${suffix}`, subject, metric: `idle wakeups, ${state.label}`, unit: '/s', better: 'lower', stats: summarize(kept.map((w) => w.wakeupsPerS), '/s'), conditions },
      { id: `${SUITE}.${state.id}.memory.${suffix}`, subject, metric: `memory (phys_footprint), ${state.label}`, unit: 'MiB', better: 'lower', stats: summarize(kept.map((w) => w.footprintMiB), 'MiB'), conditions }
    )
  }
}

writeSuiteResult(SUITE, {
  versions: { pod: { ...outerInfo, podNativeRevision } },
  config: { launches, variants, warmupS, settleS, windowS, states: STATES },
  caveats: [
    'PodNative ran as --background: the window is laid out and drawn but never ordered in, so nothing showed on screen. Git and the tab snapshots treat it as on screen, the status bar as hidden: not a visible window and not a closed one.',
    'acc-on reads a stub claude-acc state (PodNative\'s mac-e2e fixtures) that a writer rewrites at claude-acc\'s live rates, as a default install reads the real one; the writer\'s own CPU is not counted. acc-off (POD_NATIVE_NO_ACC=1) is the breakdown without it.',
    'The memory row sums phys_footprint over PodNative, the runtime, its helpers and the terminal daemon; the terminals\' shells are not counted.',
    `A window counts only when the 1-minute load average was at most ${MAX_LOAD} when it started.`
  ],
  metrics,
  launches: results
})
