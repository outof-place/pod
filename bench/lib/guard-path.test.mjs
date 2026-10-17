import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GUARD_PATH_REVISION, guardVerdict, prepareGuard } from './guard-path.mjs'

const PODNATIVE_REPO = path.join(os.homedir(), 'Documents/orca-native-wt/native-ui/PodNative')
const haveHelper = (() => {
  try {
    execFileSync('git', ['-C', PODNATIVE_REPO, 'cat-file', '-e', `${GUARD_PATH_REVISION}:scripts/guard-path.sh`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function stub(guard, name, args, pathValue) {
  try {
    execFileSync(path.join(guard.path.split(':').find((dir) => dir.endsWith('/guard-bin')), name), args, {
      env: { PATH: pathValue },
      stdio: 'ignore'
    })
  } catch {}
}

test(
  'the guard PATH puts a stub first for every agent, and its verdict catches a stub reached off it',
  { skip: !haveHelper && `PodNative ${GUARD_PATH_REVISION} not in ${PODNATIVE_REPO}` },
  () => {
    const run = realpathSync(mkdtempSync('/private/tmp/guard-path-test.'))
    try {
      const ud = path.join(run, 'ud')
      const home = path.join(run, 'home')
      mkdirSync(ud)
      mkdirSync(home)
      const guard = prepareGuard(run, { ud, homes: [home], claudeVersion: '2.1.302' })
      assert.match(guard.path, new RegExp(`^${run}/guard-bin:/usr/bin:/bin:/usr/sbin:/sbin$`))
      assert.equal(guard.env.ORCA_E2E_USER_DATA_DIR, ud)
      assert.equal(guard.env.GIT_CONFIG_NOSYSTEM, '1')
      assert.ok(readFileSync(path.join(home, '.zprofile'), 'utf8').includes(`${run}/guard-bin`))
      assert.equal(guardVerdict(run).ok, false, 'nothing logged yet proves nothing')
      stub(guard, 'claude', ['--version'], guard.path)
      assert.deepEqual(guardVerdict(run), { ok: true, problems: [] })
      stub(guard, 'codex', ['--version'], `/opt/homebrew/bin:${guard.path}`)
      assert.match(guardVerdict(run).problems.join(' '), /before guard-bin/)
    } finally {
      const remover = path.join(os.homedir(), '.local/bin/pod-tmp-rm')
      if (existsSync(remover)) execFileSync(remover, [run], { stdio: 'ignore' })
    }
  }
)

test(
  'claude past --version makes the run fail',
  { skip: !haveHelper && `PodNative ${GUARD_PATH_REVISION} not in ${PODNATIVE_REPO}` },
  () => {
    const run = realpathSync(mkdtempSync('/private/tmp/guard-path-test.'))
    try {
      const ud = path.join(run, 'ud')
      mkdirSync(ud)
      const guard = prepareGuard(run, { ud, homes: [], claudeVersion: '2.1.302' })
      stub(guard, 'claude', ['-p', 'hello'], guard.path)
      assert.match(guardVerdict(run).problems.join(' '), /claude run past --version/)
    } finally {
      const remover = path.join(os.homedir(), '.local/bin/pod-tmp-rm')
      if (existsSync(remover)) execFileSync(remover, [run], { stdio: 'ignore' })
    }
  }
)
