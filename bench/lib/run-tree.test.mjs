import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sleep } from './bench-session.mjs'
import { PROCSTAT, runTree, signalTargets, stopRunTree } from './run-tree.mjs'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('signalTargets keeps the exe tree only, never the caller or a protected program', () => {
  const procs = [
    { pid: 10, via: 'exe', path: '/private/tmp/run/App.app/Contents/MacOS/App' },
    { pid: 11, via: 'exe', inherited: true, path: '/bin/zsh' },
    { pid: 12, via: 'argv', path: '/usr/bin/tail' },
    { pid: 13, via: 'argv', inherited: true, path: '/bin/zsh' },
    { pid: 14, via: 'exe', path: '/Applications/Pod.app/Contents/MacOS/PodNative' },
    { pid: 15, via: 'exe', path: '/private/tmp/run/tool' }
  ]
  const targets = signalTargets(procs, { protectedPrefixes: ['/Applications/'], self: 15 })
  assert.deepEqual(
    targets.map((proc) => proc.pid),
    [10, 11]
  )
})

test(
  "a stranger's process that names the run dir survives the cleanup; the run's own tree does not",
  { skip: !existsSync(PROCSTAT) && 'build the tools first (tools/build.sh)' },
  async () => {
    const work = realpathSync(mkdtempSync('/private/tmp/run-tree-test.'))
    mkdirSync(path.join(work, 'bin'))
    mkdirSync(path.join(work, 'out'))
    writeFileSync(path.join(work, 'out/app.log'), '')
    // The run's own program: an executable inside the run dir whose child runs outside it, with
    // the run dir in its argv (as a command in one of the run's terminals would have).
    writeFileSync(
      path.join(work, 'bin/app.c'),
      '#include <unistd.h>\nint main(int argc, char **argv) { if (argc > 1 && fork() == 0) { execl("/bin/sh", "sh", "-c", argv[1], (char *)0); _exit(1); } sleep(30); return 0; }\n'
    )
    execFileSync('xcrun', ['clang', '-O2', '-o', path.join(work, 'bin/app'), path.join(work, 'bin/app.c')])
    const own = spawn(path.join(work, 'bin/app'), [`sleep 30; : ${work}/out/app.log`], { stdio: 'ignore' })
    // A stranger following a log in the run dir, as someone's `tail -f` would.
    const stranger = spawn('/usr/bin/tail', ['-f', path.join(work, 'out/app.log')], { stdio: 'ignore' })
    try {
      await sleep(300)
      const before = await runTree(work, { scan: true })
      const ownTree = before.procs.filter((proc) => proc.via === 'exe').map((proc) => proc.pid)
      assert.ok(ownTree.includes(own.pid), 'the run dir program is in the tree')
      assert.ok(ownTree.length >= 2, 'with its child, whose argv names the run dir too')
      assert.ok(
        before.procs.some((proc) => proc.pid === stranger.pid && proc.via === 'argv'),
        'the stranger shows up through its argv'
      )
      const result = await stopRunTree(work, { attempts: 10, intervalMs: 100 })
      assert.deepEqual(result.left, [])
      assert.ok(result.signalled.every((entry) => ownTree.includes(entry.pid)), 'only the own tree was signalled')
      assert.ok(result.argvOnly.some((entry) => entry.pid === stranger.pid), 'the stranger was reported')
      await sleep(200)
      assert.equal(alive(own.pid) && own.exitCode === null && own.signalCode === null, false, 'the own program stopped')
      assert.equal(alive(stranger.pid), true, 'the stranger survived')
    } finally {
      for (const child of [own, stranger]) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      // The test's own /private/tmp dir, through the guarded remover where it is installed.
      const remover = path.join(os.homedir(), '.local/bin/pod-tmp-rm')
      if (existsSync(remover)) {
        await sleep(200)
        execFileSync(remover, [work], { stdio: 'ignore' })
      }
    }
  }
)
