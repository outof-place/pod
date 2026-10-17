// The guard PATH every bench launch of a real Pod (or Orca) runtime gets: PodNative's
// scripts/guard-path.sh at GUARD_PATH_REVISION (the lead's rule, 2026-10-17). Pod probes its whole
// agent catalog and the credential CLIs, and its hydrateShellPath puts the profile's login-shell
// PATH first, so stubbing claude alone is not enough: the helper links a stub for every command
// the catalog names, keeps them first in every shell of the profile's HOME, and logs each call's
// PATH (and its environment's names, never a value) so the run can prove it afterwards.
//
//   prepareGuard(run, { ud, homes, fronts, tree, claudeVersion })
//     once per run dir: the helper's files copied into <run>/guard-lib, refuse_in_pod_terminal
//     (pod-terminal-guard.sh: no run from inside a Pod terminal), build_guard_path (refuses when
//     the app's catalog names an agent without a stub), build_guard_home on each HOME (or ZDOTDIR),
//     guard_path_env; returns { path, env, fronts, lib }
//   guardVerdict(run, fronts)
//     after the run: guard_bin_first (every logged PATH had guard-bin first), guard_path_abort (no
//     claude ran past --version) and guard_env_names_check (no stub call had the caller's canary,
//     and some had the positive mark); returns { ok, problems, envNames }
//   guardExecScript(run, words, fronts)
//     the bash that guard_exec's a command with these NAME=VALUE words (the runtime's exec)
//   envPidCheck(run, pid, label)
//     guard_env_pid_check on one of the run's own pids: the mark and no canary (status 0)
//
// The app's environment is an allowlist, never the caller's (the lead's MUST, 2026-10-17: `open`
// hands an app its caller's whole environment). guard_exec and app_open start from `env -i` and add
// GUARD_POSITIVE_MARK=1; the caller sets GUARD_CANARY_TOKEN in its own environment (callerCanary)
// before it starts anything. A check that can't see the mark proves nothing and fails the run.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const GUARD_PATH_REVISION = '18b5702935a388d7b3f9fff3adccb1e87e859862'
const PODNATIVE_REPO = path.join(os.homedir(), 'Documents/orca-native-wt/native-ui/PodNative')
// open-app.sh (app_open) and the run-procs.sh it sources: native-idle opens PodNative through them.
// pod-terminal-guard.sh: the waiver's ancestry check before a runtime is exec'd from a shell.
const FILES = ['guard-path.sh', 'guard-agents.txt', 'guard-agents.py', 'open-app.sh', 'run-procs.sh', 'pod-terminal-guard.sh']
// LaunchServices adds its launchd session's values of these on top of what `open --env` gives:
// open-app.sh's APP_ENV_BLANK, which app_open passes as empty --env (PodNative's runtime gets them
// through --runtime-env).
export const APP_ENV_BLANK = ['SSH_AUTH_SOCK', 'USER', 'LOGNAME', 'DISPLAY']
export const ENV_CANARY = 'GUARD_CANARY_TOKEN'
export const POSITIVE_MARK = 'GUARD_POSITIVE_MARK'

let canary = null
/** The caller's canary: one per bench process, in its own environment, which no launch may pass on. */
export function callerCanary() {
  canary ??= randomBytes(16).toString('hex')
  process.env[ENV_CANARY] = canary
  return canary
}

function helper(run, script, args, env = {}) {
  return execFileSync(
    '/usr/bin/env',
    [
      '-i',
      // The helper links rg, node and jq where this shell finds them, so it gets this PATH.
      `PATH=${process.env.PATH}`,
      // Nothing of the helper's own shell needs the account's home.
      `HOME=${run}`,
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      '/bin/bash',
      '-c',
      // Status 3 when the helper can't be read: never mistaken for one of its own verdicts.
      `. "$1/guard-path.sh" || exit 3; shift; ${script}`,
      'guard',
      path.join(run, 'guard-lib'),
      ...args
    ],
    { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

// What a helper call printed, for a problem line: its first lines, stdout and stderr.
const said = (error) =>
  `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`.trim().split('\n').slice(0, 5).join('; ')

/** The installed claude's version from its install path (~/.local/bin/claude -> versions/<v>); never runs it. */
export function installedClaudeVersion() {
  const target = readlinkSync(path.join(os.homedir(), '.local/bin/claude'))
  const version = path.basename(target)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`cannot read the claude version from ${target}`)
  return version
}

export function prepareGuard(run, { ud, homes, fronts = [], tree, claudeVersion = '0.0.0' }) {
  const lib = path.join(run, 'guard-lib')
  mkdirSync(lib, { mode: 0o700 })
  for (const file of FILES) {
    const text = execFileSync('git', ['-C', PODNATIVE_REPO, 'show', `${GUARD_PATH_REVISION}:scripts/${file}`], {
      encoding: 'utf8',
      maxBuffer: 16 << 20
    })
    writeFileSync(path.join(lib, file), text, { mode: 0o600 })
  }
  // The headless-exec waiver's condition: this process's parents (by executable) include no Pod
  // terminal daemon or runtime. It exits 2 with the ancestor named.
  helper(run, '. "$GUARD_PATH_HERE/pod-terminal-guard.sh" || exit 3; refuse_in_pod_terminal', [])
  const built = helper(run, 'build_guard_path "$@"', [run, ...(tree ? [tree] : [])], {
    GUARD_CLAUDE_VERSION: claudeVersion
  })
  const guardPath = built.trim().split('\n').pop()
  if (!guardPath.startsWith(`${run}/guard-bin:`)) {
    throw new Error(`guard-path.sh build_guard_path printed no guard PATH: ${built.slice(-300)}`)
  }
  for (const home of homes) {
    helper(run, 'build_guard_home "$@"', [home, run, ...fronts])
  }
  const env = Object.fromEntries(
    helper(run, 'guard_path_env "$@"', [run, ud])
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
  return { path: [...fronts, guardPath].join(':'), env, fronts, lib, revision: GUARD_PATH_REVISION }
}

export function guardVerdict(run, fronts = []) {
  const problems = []
  try {
    helper(run, 'guard_bin_first "$@"', [run, ...fronts])
  } catch (error) {
    // guard_bin_first: 1 lists the entries before guard-bin, 2 is no PATH logged (or no run dir).
    problems.push(
      error.status === 1
        ? `PATH entries before guard-bin: ${said(error)}`
        : error.status === 2
          ? `nothing proves the stubs were first: ${said(error)}`
          : `guard_bin_first failed (status ${error.status}): ${said(error)}`
    )
  }
  // guard_path_abort: 0 when a stub saw claude run past --version, 1 when none did; any other
  // status (the helper unreadable, a bad run dir) is no verdict and fails the run too.
  let abort
  try {
    abort = helper(run, 'if guard_path_abort "$@"; then echo abort; else s=$?; [ "$s" = 1 ] || exit "$s"; echo clean; fi', [run]).trim()
  } catch (error) {
    abort = `failed (status ${error.status}): ${said(error)}`
  }
  if (abort === 'abort') problems.push('a stub saw claude run past --version')
  else if (abort !== 'clean') problems.push(`guard_path_abort ${abort}`)
  // guard_env_names_check: 1 when a stub call had the canary, 2 when none had the mark (no proof).
  let envNames = null
  try {
    envNames = helper(run, 'guard_env_names_check "$@"', [run]).trim()
  } catch (error) {
    problems.push(
      error.status === 1
        ? `the caller's canary reached a stub: ${said(error)}`
        : error.status === 2
          ? `no stub call shows ${POSITIVE_MARK}, so no proof the canary stayed out: ${said(error)}`
          : `guard_env_names_check failed (status ${error.status}): ${said(error)}`
    )
  }
  return { ok: problems.length === 0, problems, envNames }
}

// A word in single quotes for bash.
const quoted = (word) => `'${String(word).replaceAll("'", "'\\''")}'`

/**
 * A bash script that guard_exec's `exe` with the arguments it is given ("$@") and only these
 * NAME=VALUE words (guard-path.sh at GUARD_PATH_REVISION: env -i, HOME, PATH with the run's
 * guard-bin first after the --front dirs, TMPDIR, SHELL, LANG, GUARD_POSITIVE_MARK=1). For a
 * launcher that must name an executable itself (Playwright): exec keeps the pid the app's.
 */
export function guardExecScript(run, { words, fronts = [], exe }) {
  for (const [name] of Object.entries(words)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`guardExecScript: a bad name ('${name}')`)
  }
  return [
    '#!/bin/bash',
    '# lib/orca-instance.mjs: this launch through guard-path.sh guard_exec, its arguments as given.',
    `. ${quoted(path.join(run, 'guard-lib/guard-path.sh'))} || exit 3`,
    `guard_exec ${quoted(run)} ${fronts.map((dir) => `--front ${quoted(dir)} `).join('')}\\`,
    ...Object.entries(words).map(([name, value]) => `  ${quoted(`${name}=${value}`)} \\`),
    `  -- ${quoted(exe)} "$@"`,
    ''
  ].join('\n')
}

/**
 * guard_env_pid_check on one of the run's own pids (never another's): status 0 when it has the
 * mark and no canary, 1 with the canary, 2 without the mark (not started by guard_exec or
 * app_open, gone, or a platform binary, whose environment `ps -E` doesn't show). Never a value.
 */
export function envPidCheck(run, pid, label) {
  try {
    return { pid, label, status: 0, said: helper(run, 'guard_env_pid_check "$@"', [String(pid), label]).trim() }
  } catch (error) {
    return { pid, label, status: error.status ?? -1, said: said(error) }
  }
}
