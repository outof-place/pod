// The guard PATH every bench launch of a real Pod (or Orca) runtime gets: PodNative's
// scripts/guard-path.sh at GUARD_PATH_REVISION (the lead's rule, 2026-10-17). Pod probes its whole
// agent catalog and the credential CLIs, and its hydrateShellPath puts the profile's login-shell
// PATH first, so stubbing claude alone is not enough: the helper links a stub for every command
// the catalog names, keeps them first in every shell of the profile's HOME, and logs each call's
// PATH so the run can prove it afterwards.
//
//   prepareGuard(run, { ud, homes, fronts, tree, claudeVersion })
//     once per run dir: the helper's files copied into <run>/guard-lib, build_guard_path (refuses
//     when the app's catalog names an agent without a stub), build_guard_home on each HOME (or
//     ZDOTDIR), guard_path_env; returns { path, env, fronts }
//   guardVerdict(run, fronts)
//     after the run: guard_bin_first (every logged PATH had guard-bin first) and guard_path_abort
//     (no claude ran past --version); returns { ok, problems }
import { execFileSync } from 'node:child_process'
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const GUARD_PATH_REVISION = '5d1a1b2f6b1bfe35b835b628d1a4a4851172cf8e'
const PODNATIVE_REPO = path.join(os.homedir(), 'Documents/orca-native-wt/native-ui/PodNative')
const FILES = ['guard-path.sh', 'guard-agents.txt', 'guard-agents.py']

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
      `. "$1/guard-path.sh"; shift; ${script}`,
      'guard',
      path.join(run, 'guard-lib'),
      ...args
    ],
    { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

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
  return { path: [...fronts, guardPath].join(':'), env, fronts, revision: GUARD_PATH_REVISION }
}

export function guardVerdict(run, fronts = []) {
  const problems = []
  try {
    helper(run, 'guard_bin_first "$@"', [run, ...fronts])
  } catch (error) {
    problems.push(
      error.status === 2
        ? 'no stub logged a PATH: nothing proves the stubs were first'
        : `PATH entries before guard-bin: ${String(error.stdout).trim().split('\n').slice(0, 5).join('; ')}`
    )
  }
  try {
    helper(run, 'guard_path_abort "$@"', [run])
    problems.push('a stub saw claude run past --version')
  } catch {}
  return { ok: problems.length === 0, problems }
}
