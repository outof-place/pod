// Isolated, windowless Orca/Pod instances: a throwaway profile, a hermetic zsh, the app's own CLI
// pointed at that profile, and cleanup of every process the profile spawned. Never touches the
// real profile (~/Library/Application Support/orca) or the user's running Orca.
import { execFile, execFileSync, spawn } from 'node:child_process'
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
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ACC_OFF_ENV,
  assertAccOff,
  checkAcc,
  guardInstance,
  releaseInstance
} from './acc-guard.mjs'
import { BENCH_ROOT, TOOLS_BIN, log, sleep } from './bench-session.mjs'

const HOME = os.homedir()
export const ORCA_APP = process.env.POD_BENCH_ORCA_APP ?? '/Applications/Orca.app'
export const POD_APP =
  process.env.POD_BENCH_POD_APP ??
  path.join(HOME, 'Library/Application Support/orca-native/builds/latest/Orca.app')
const REAL_PROFILE = path.join(HOME, 'Library/Application Support/orca')
// Short base: the daemon socket <userData>/daemon/daemon-v<N>.sock must fit in 104 bytes.
export const PROFILE_BASE = path.join(HOME, 'Library/Application Support/orca-native/bench')
const REPO_ROOT = path.dirname(BENCH_ROOT)
const run = promisify(execFile)

/** The benchmark subjects: an app bundle plus the terminal renderer it runs with. */
export const SUBJECTS = {
  orca: { app: ORCA_APP, nativeTerminal: false, label: 'Orca (xterm.js)' },
  'pod-xterm': { app: POD_APP, nativeTerminal: false, label: 'Pod (xterm.js)' },
  'pod-native': {
    app: POD_APP,
    nativeTerminal: true,
    label: 'Pod (native Ghostty terminal)',
    // Where the native terminal comes from.
    branch: 'feat/native-ghostty-terminal',
    upstream: 'https://github.com/stablyai/orca/pull/26914'
  }
}

function plistValue(file, key) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return null
  }
}

function plist(appPath, key) {
  return execFileSync(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', `${appPath}/Contents/Info.plist`],
    { encoding: 'utf8' }
  ).trim()
}

export function describeApp(appPath) {
  const real = realpathSync(appPath)
  let build = null
  try {
    build = JSON.parse(readFileSync(`${real}/Contents/Resources/orca-local-build.json`, 'utf8'))
  } catch {}
  const codesign = execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1 || true', 'sh', real], {
    encoding: 'utf8'
  })
  return {
    path: appPath,
    realPath: real,
    bundleId: plist(real, 'CFBundleIdentifier'),
    version: plist(real, 'CFBundleShortVersionString'),
    buildId: build?.buildId ?? null,
    commit: build?.commit ?? null,
    teamId: codesign.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
    executable: `${real}/Contents/MacOS/${plist(real, 'CFBundleExecutable')}`,
    electron: plistValue(
      `${real}/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`,
      'CFBundleVersion'
    ),
    // Pod renames the CLI (product/identity.json cliName).
    cli: ['orca', 'podx']
      .map((name) => `${real}/Contents/Resources/bin/${name}`)
      .find((candidate) => existsSync(candidate))
  }
}

/** playwright-core from this checkout, or from POD_BENCH_CHECKOUT when this one has no node_modules. */
export function loadPlaywright() {
  for (const root of [
    process.env.POD_BENCH_CHECKOUT,
    REPO_ROOT,
    path.join(HOME, 'Documents/orca-native')
  ]) {
    if (root && existsSync(path.join(root, 'node_modules/playwright-core/package.json'))) {
      const require = createRequire(path.join(root, 'package.json'))
      return {
        playwright: require('playwright-core'),
        version: require('playwright-core/package.json').version,
        root
      }
    }
  }
  throw new Error(
    'playwright-core not found: run pnpm install, or set POD_BENCH_CHECKOUT to a checkout that has it'
  )
}

let seedCache = null
/** The E2E suite's completed-onboarding profile (tests/e2e/helpers), so no first-run overlay covers a pane. */
function completedOnboardingSeed() {
  if (seedCache) {
    return structuredClone(seedCache)
  }
  const { root } = loadPlaywright()
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  const out = execFileSync(
    tsx,
    [
      '-e',
      "import { getE2ECompletedOnboardingProfile } from './tests/e2e/helpers/e2e-completed-onboarding-profile.ts'; console.log(JSON.stringify(getE2ECompletedOnboardingProfile()))"
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  seedCache = JSON.parse(out)
  return structuredClone(seedCache)
}

/** One small git repo the benchmark workspaces open; outside any profile so profiles can be reset. */
export function benchRepo() {
  const repo = path.join(PROFILE_BASE, 'repo')
  if (!existsSync(path.join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true })
    const git = (args) =>
      execFileSync(
        'git',
        ['-c', 'user.email=bench@pod.invalid', '-c', 'user.name=bench', ...args],
        { cwd: repo }
      )
    git(['init', '-q', '-b', 'main'])
    writeFileSync(path.join(repo, 'README.md'), 'pod benchmark workspace\n')
    git(['add', 'README.md'])
    git(['commit', '-qm', 'init'])
  }
  return repo
}

/**
 * A throwaway profile: completed onboarding, telemetry off, the given settings, and a ZDOTDIR whose
 * .zshrc only logs each prompt's time. Orca's zsh wrapper restores ZDOTDIR, so panes never read the
 * user's own shell config.
 */
export function createProfile(settings = {}) {
  mkdirSync(PROFILE_BASE, { recursive: true })
  const ud = mkdtempSync(path.join(PROFILE_BASE, 'p'))
  const home = path.join(ud, 'home')
  const zdot = path.join(ud, 'zdot')
  mkdirSync(home, { recursive: true })
  mkdirSync(zdot)
  const seed = completedOnboardingSeed()
  seed.settings = {
    ...seed.settings,
    ...settings,
    telemetry: { ...seed.settings.telemetry, optedIn: false }
  }
  seed.ui = { ...seed.ui, lastUpdateCheckAt: Date.now() }
  writeFileSync(path.join(ud, 'orca-data.json'), `${JSON.stringify(seed, null, 2)}\n`)
  writeFileSync(
    path.join(zdot, '.zshrc'),
    'zmodload zsh/datetime\nprecmd() { print -r -- $EPOCHREALTIME >> $POD_BENCH_PROMPT_LOG }\nPS1="%# "\n'
  )
  writeFileSync(path.join(home, '.hushlogin'), '')
  return { ud, home, zdot, promptLog: path.join(ud, 'prompt.log'), repo: benchRepo() }
}

/** First-prompt times (epoch ms) the hermetic zsh logged, oldest first. */
export function promptTimes(profile) {
  if (!existsSync(profile.promptLog)) {
    return []
  }
  return readFileSync(profile.promptLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => Number(line) * 1000)
}

export function launchEnv(profile, { visible = false } = {}) {
  const presentation = visible
    ? // Only for the visible-window latency run, in a slot the user agreed to.
      { ORCA_E2E_HEADFUL: '1', ORCA_E2E_FOREGROUND: '1' }
    : // foreground-activation-policy.ts: no Dock tile, no menu bar, no window, no activation.
      { ORCA_E2E_HEADLESS: '1', ORCA_BACKGROUND_LAUNCH: '1' }
  return {
    PATH: `${TOOLS_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: profile.home,
    SHELL: '/bin/zsh',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    // configure-process.ts: the userData override packaged builds honour; HOME must equal ORCA_E2E_HOME_DIR.
    ORCA_E2E_USER_DATA_DIR: profile.ud,
    ORCA_E2E_HOME_DIR: profile.home,
    ...presentation,
    ZDOTDIR: profile.zdot,
    POD_BENCH_PROMPT_LOG: profile.promptLog,
    // Never let the packaged Pod run claude-acc's setup.sh (acc-guard.mjs).
    ...ACC_OFF_ENV
  }
}

// If the guard trips, it must stop the instance synchronously before exiting.
function guard(pid, profile) {
  guardInstance(pid, () => execFileSync('/usr/bin/pkill', ['-KILL', '-f', '--', profile.ud]))
}

const CHROMIUM_ARGS = [
  // tests/e2e/helpers/electron-launch-args.ts: never touch the login keychain.
  '--password-store=basic',
  '--use-mock-keychain',
  // As tests/e2e/native-terminal-ghostty-perf.spec.ts: a hidden window must keep rendering.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]

function assertIsolated(profile) {
  const ud = realpathSync(profile.ud)
  if (ud === REAL_PROFILE || !ud.startsWith(realpathSync(PROFILE_BASE))) {
    throw new Error(`refusing to use a non-benchmark profile: ${ud}`)
  }
}

/** Plain spawn, no automation attached: used for startup timing. */
export function spawnInstance(appPath, profile) {
  assertIsolated(profile)
  const info = describeApp(appPath)
  const env = launchEnv(profile)
  assertAccOff(env)
  const spawnedAt = Date.now()
  const child = spawn(info.executable, [...CHROMIUM_ARGS, '-ApplePersistenceIgnoreState', 'YES'], {
    env,
    stdio: 'ignore',
    detached: false
  })
  guard(child.pid, profile)
  return { child, pid: child.pid, profile, info, spawnedAt }
}

/** Playwright launch with background throttling off on every window, as the nt-perf spec does. */
export async function launchInstance(appPath, profile, { visible = false } = {}) {
  assertIsolated(profile)
  const info = describeApp(appPath)
  const { playwright } = loadPlaywright()
  const env = launchEnv(profile, { visible })
  assertAccOff(env)
  const spawnedAt = Date.now()
  const app = await playwright._electron.launch({
    executablePath: info.executable,
    args: [...CHROMIUM_ARGS, '-ApplePersistenceIgnoreState', 'YES'],
    env,
    timeout: 180_000
  })
  guard(app.process().pid, profile)
  const page = await app.firstWindow({ timeout: 180_000 })
  const firstWindowAt = Date.now()
  checkAcc(`after launching ${info.realPath}`)
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
    electronApp.on('browser-window-created', (_event, window) =>
      window.webContents.setBackgroundThrottling(false)
    )
  })
  return { app, page, pid: app.process().pid, profile, info, spawnedAt, firstWindowAt }
}

/** The instance's own CLI against its own profile; returns the parsed `result`. */
export async function cli(instance, args, timeoutMs = 120_000) {
  assertIsolated(instance.profile)
  let stdout
  try {
    ;({ stdout } = await run(instance.info.cli, [...args, '--json'], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: instance.profile.home,
        ORCA_USER_DATA_PATH: instance.profile.ud,
        ...ACC_OFF_ENV
      },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    }))
  } catch (error) {
    // A failing --json call prints its reason on stdout; keep it in the error.
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().slice(0, 600)
    throw new Error(`orca ${args.join(' ')} (exit ${error.code}): ${output}`)
  }
  const parsed = JSON.parse(stdout)
  if (!parsed.ok) {
    throw new Error(`orca ${args.join(' ')}: ${stdout.slice(0, 400)}`)
  }
  return parsed.result
}

/** Waits until the profile's runtime metadata exists (the CLI can reach the instance). */
export async function waitForRuntime(instance, timeoutMs = 120_000) {
  const file = path.join(instance.profile.ud, 'orca-runtime.json')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error('runtime never came up')
    }
    await sleep(10)
  }
  return Date.now()
}

/** Adds the bench repo and opens one focused terminal tab in it; returns its handle. */
export async function openTerminal(instance) {
  await waitForRuntime(instance)
  await cli(instance, ['repo', 'add', '--path', instance.profile.repo])
  // The app may still be scanning the repo it just added; untimed setup, so wait it out.
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const created = await cli(instance, [
        'terminal',
        'create',
        '--worktree',
        `path:${instance.profile.repo}`,
        '--focus'
      ])
      return created.terminal.handle
    } catch (error) {
      if (Date.now() > deadline) {
        throw error
      }
      log(`terminal create not ready yet: ${error.message.slice(0, 300)}`)
      await sleep(500)
    }
  }
}

export async function waitForPrompts(profile, count, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const times = promptTimes(profile)
    if (times.length >= count) {
      return times
    }
    if (Date.now() > deadline) {
      throw new Error(`only ${times.length}/${count} prompts after ${timeoutMs} ms`)
    }
    await sleep(20)
  }
}

/** Every process under `rootPid` (plus any whose argv names `argvNeedle`), classified by role. */
export async function snapshotProcesses(rootPid, argvNeedle = null) {
  const args = ['--root', String(rootPid), ...(argvNeedle ? ['--argv', argvNeedle] : [])]
  const { stdout } = await run(path.join(TOOLS_BIN, 'procstat'), args)
  const snapshot = JSON.parse(stdout)
  for (const proc of snapshot.procs) {
    proc.role = roleOf(proc, rootPid)
  }
  return snapshot
}

/** Every process of the instance with per-process CPU and memory, classified by role. */
export function processSnapshot(instance) {
  return snapshotProcesses(instance.pid, instance.profile.ud)
}

const WORKLOAD_NAMES = new Set(['zsh', 'login', 'termload', 'seq', 'cat', 'sleep', 'bash', 'sh'])

function roleOf(proc, mainPid) {
  if (proc.pid === mainPid) {
    return 'main'
  }
  if (WORKLOAD_NAMES.has(proc.name)) {
    return 'shell'
  }
  if (proc.args.includes('--type=renderer')) {
    return 'renderer'
  }
  if (proc.args.includes('--type=gpu-process')) {
    return 'gpu'
  }
  if (proc.args.includes('daemon-entry.js')) {
    return 'daemon'
  }
  return 'helper'
}

/** App CPU (ms) and memory by role between two snapshots; shells and workloads are excluded. */
export function appUsage(before, after) {
  const byRole = {}
  let cpuMs = 0
  let footprint = 0
  let rss = 0
  const previous = new Map(before ? before.procs.map((proc) => [proc.pid, proc]) : [])
  for (const proc of after.procs) {
    if (proc.role === 'shell') {
      continue
    }
    const role = (byRole[proc.role] ??= { cpuMs: 0, footprintMB: 0, rssMB: 0, count: 0 })
    const delta = before
      ? (proc.cpuNs - (previous.get(proc.pid)?.cpuNs ?? 0)) / 1e6
      : proc.cpuNs / 1e6
    role.cpuMs += delta
    role.footprintMB += proc.footprint / 2 ** 20
    role.rssMB += proc.rss / 2 ** 20
    role.count += 1
    cpuMs += delta
    footprint += proc.footprint
    rss += proc.rss
  }
  return { cpuMs, footprintMB: footprint / 2 ** 20, rssMB: rss / 2 ** 20, byRole }
}

async function killProfileProcesses(profile) {
  for (const signal of ['TERM', 'KILL']) {
    try {
      execFileSync('/usr/bin/pkill', [`-${signal}`, '-f', '--', profile.ud])
    } catch {}
    for (let i = 0; i < 30; i += 1) {
      try {
        execFileSync('/usr/bin/pgrep', ['-f', '--', profile.ud])
      } catch {
        return
      }
      await sleep(100)
    }
  }
}

/** Quits the instance, kills its terminal daemon and shells, and (for non-/Applications builds) unregisters it from LaunchServices. */
export async function closeInstance(instance, { keepProfile = false } = {}) {
  if (instance.app) {
    const proc = instance.app.process()
    await Promise.race([instance.app.close().catch(() => {}), sleep(30_000)])
    proc.stdout?.destroy()
    proc.stderr?.destroy()
  } else if (instance.child && instance.child.exitCode === null) {
    instance.child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => instance.child.once('exit', resolve)),
      sleep(30_000)
    ])
  }
  await killProfileProcesses(instance.profile)
  releaseInstance(instance.pid)
  checkAcc(`after closing ${instance.info.realPath}`)
  if (!instance.info.realPath.startsWith('/Applications/')) {
    try {
      execFileSync(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-u', instance.info.realPath]
      )
    } catch {}
  }
  if (!keepProfile) {
    rmSync(instance.profile.ud, { recursive: true, force: true })
  }
}

/** Kills anything still running for the profile and deletes it. */
export async function removeProfile(profile) {
  await killProfileProcesses(profile)
  rmSync(profile.ud, { recursive: true, force: true })
}

/** Chromium caches a first launch builds; deleting them makes the next launch "cold". */
export const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
  'blob_storage'
]

export function dropCaches(profile) {
  for (const dir of CHROMIUM_CACHE_DIRS) {
    rmSync(path.join(profile.ud, dir), { recursive: true, force: true })
  }
}

export function resetPromptLog(profile) {
  rmSync(profile.promptLog, { force: true })
}
