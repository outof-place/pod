import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ENV_CANARY,
  GUARD_PATH_REVISION,
  POSITIVE_MARK,
  callerCanary,
  envPidCheck,
  guardExecScript,
  guardVerdict,
  prepareGuard
} from './guard-path.mjs'

const PODNATIVE_REPO = path.join(os.homedir(), 'Documents/orca-native-wt/native-ui/PodNative')
const haveHelper = (() => {
  try {
    execFileSync('git', ['-C', PODNATIVE_REPO, 'cat-file', '-e', `${GUARD_PATH_REVISION}:scripts/guard-path.sh`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const needsHelper = { skip: !haveHelper && `PodNative ${GUARD_PATH_REVISION} not in ${PODNATIVE_REPO}` }

function removeRun(run) {
  const remover = path.join(os.homedir(), '.local/bin/pod-tmp-rm')
  if (existsSync(remover)) execFileSync(remover, [run], { stdio: 'ignore' })
}

// A fresh run dir with a guard (no catalog: these tests read no app).
function guardedRun(homes = []) {
  const run = realpathSync(mkdtempSync('/private/tmp/guard-path-test.'))
  const ud = path.join(run, 'ud')
  mkdirSync(ud)
  for (const home of homes) mkdirSync(path.join(run, home))
  return { run, ud, guard: prepareGuard(run, { ud, homes: homes.map((home) => path.join(run, home)), claudeVersion: '2.1.302' }) }
}

// One stub call, as a process with exactly this env would make it.
function stub(guard, name, args, env) {
  try {
    execFileSync(path.join(guard.path.split(':').find((dir) => dir.endsWith('/guard-bin')), name), args, {
      env,
      stdio: 'ignore'
    })
  } catch {}
}

test(
  'the guard PATH puts a stub first for every agent, and its verdict catches a stub reached off it',
  needsHelper,
  () => {
    const { run, ud, guard } = guardedRun(['home'])
    try {
      assert.match(guard.path, new RegExp(`^${run}/guard-bin:/usr/bin:/bin:/usr/sbin:/sbin$`))
      assert.equal(guard.env.ORCA_E2E_USER_DATA_DIR, ud)
      assert.equal(guard.env.GIT_CONFIG_NOSYSTEM, '1')
      assert.ok(readFileSync(path.join(run, 'home/.zprofile'), 'utf8').includes(`${run}/guard-bin`))
      assert.equal(guardVerdict(run).ok, false, 'nothing logged yet proves nothing')
      // A call from a process guard_exec or app_open started: it has the positive mark.
      stub(guard, 'claude', ['--version'], { PATH: guard.path, [POSITIVE_MARK]: '1' })
      const clean = guardVerdict(run)
      assert.deepEqual(clean.problems, [])
      assert.match(clean.envNames, /1 stub call\(s\) with the marker/)
      stub(guard, 'codex', ['--version'], { PATH: `/opt/homebrew/bin:${guard.path}`, [POSITIVE_MARK]: '1' })
      assert.match(guardVerdict(run).problems.join(' '), /before guard-bin/)
    } finally {
      removeRun(run)
    }
  }
)

test('claude past --version makes the run fail', needsHelper, () => {
  const { run, guard } = guardedRun()
  try {
    stub(guard, 'claude', ['-p', 'hello'], { PATH: guard.path, [POSITIVE_MARK]: '1' })
    assert.match(guardVerdict(run).problems.join(' '), /claude run past --version/)
  } finally {
    removeRun(run)
  }
})

test("a stub call with the caller's canary fails the run, and one without the mark proves nothing", needsHelper, () => {
  const { run, guard } = guardedRun()
  try {
    stub(guard, 'codex', ['--version'], { PATH: guard.path })
    assert.match(guardVerdict(run).problems.join(' '), new RegExp(`no stub call shows ${POSITIVE_MARK}`))
    stub(guard, 'codex', ['--version'], { PATH: guard.path, [POSITIVE_MARK]: '1', [ENV_CANARY]: 'x' })
    assert.match(guardVerdict(run).problems.join(' '), /the caller's canary reached a stub/)
  } finally {
    removeRun(run)
  }
})

test('a verdict the helper could not give fails the run, and is never read as "no claude ran"', () => {
  // No guard-lib in this run dir: sourcing guard-path.sh fails (status 3) for every check.
  const run = realpathSync(mkdtempSync('/private/tmp/guard-path-test.'))
  try {
    const { ok, problems } = guardVerdict(run)
    assert.equal(ok, false)
    assert.equal(problems.length, 3, problems.join('; '))
    assert.match(problems[0], /guard_bin_first failed \(status 3\)/)
    assert.match(problems[1], /guard_path_abort failed \(status 3\)/)
    assert.match(problems[2], /guard_env_names_check failed \(status 3\)/)
  } finally {
    removeRun(run)
  }
})

test(
  "guardExecScript runs the command under guard_exec's allowlist: its args as given, never the caller's env",
  needsHelper,
  async () => {
    const { run, guard } = guardedRun(['home'])
    try {
      const canary = callerCanary()
      const script = path.join(run, 'launch.sh')
      // node stands in for the app: it prints its environment's names and its arguments.
      writeFileSync(
        script,
        guardExecScript(run, {
          words: { HOME: path.join(run, 'home'), PATH: guard.path, TMPDIR: path.join(run, 't'), LANG: 'C', BENCH_WORD: "it's" },
          exe: process.execPath
        }),
        { mode: 0o700 }
      )
      const out = execFileSync(
        script,
        ['-e', 'console.log(JSON.stringify({ names: Object.keys(process.env).sort(), args: process.argv.slice(1), word: process.env.BENCH_WORD }))', 'two words'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', [ENV_CANARY]: canary, NODE_OPTIONS: '--no-warnings' } }
      )
      const seen = JSON.parse(out)
      assert.deepEqual(
        seen.names.filter((name) => name !== '__CF_USER_TEXT_ENCODING'),
        ['BENCH_WORD', POSITIVE_MARK, 'HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR']
      )
      assert.deepEqual(seen.args, ['two words'])
      assert.equal(seen.word, "it's")
      assert.throws(() => guardExecScript(run, { words: { 'A-B': '1' }, exe: process.execPath }), /a bad name/)
    } finally {
      removeRun(run)
    }
  }
)

test(
  "envPidCheck: the mark and no canary on a guard_exec'd process; the canary or no mark fails",
  needsHelper,
  async () => {
    const { run, guard } = guardedRun(['home'])
    const children = []
    try {
      const canary = callerCanary()
      const script = path.join(run, 'launch.sh')
      writeFileSync(
        script,
        guardExecScript(run, { words: { HOME: path.join(run, 'home'), PATH: guard.path }, exe: process.execPath }),
        { mode: 0o700 }
      )
      // node, not /bin/sleep: `ps -E` shows no environment of a platform binary.
      const idle = ['-e', 'setTimeout(() => {}, 30000)']
      const guarded = spawn(script, idle, { env: { PATH: '/usr/bin:/bin', [ENV_CANARY]: canary }, stdio: 'ignore' })
      const leaky = spawn(process.execPath, idle, { env: { [POSITIVE_MARK]: '1', [ENV_CANARY]: canary }, stdio: 'ignore' })
      const unmarked = spawn(process.execPath, idle, { env: {}, stdio: 'ignore' })
      children.push(guarded, leaky, unmarked)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      assert.equal(envPidCheck(run, guarded.pid, 'guarded').status, 0)
      const caught = envPidCheck(run, leaky.pid, 'leaky')
      assert.equal(caught.status, 1)
      assert.ok(!caught.said.includes(canary), 'never a value')
      assert.equal(envPidCheck(run, unmarked.pid, 'unmarked').status, 2)
    } finally {
      for (const child of children) child.kill('SIGKILL')
      removeRun(run)
    }
  }
)
