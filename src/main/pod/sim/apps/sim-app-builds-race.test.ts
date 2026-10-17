// Two runtimes, two processes, one cache miss at the same moment: one build runs, the other joins.
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLE, fakeBuildCommand, sandbox, worktree, type Sandbox } from './sim-app.test-support'

const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE || 'node'
let box: Sandbox
let worker: string

beforeEach(async () => {
  box = await sandbox()
  worker = join(box.dir, 'build-race-worker.cjs')
  await build({
    entryPoints: [join(__dirname, '__fixtures__', 'build-race-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await box.cleanup()
})

// The files' flock is Darwin's O_EXLOCK, and the pool runs only on macOS.
describe.skipIf(process.platform !== 'darwin')(
  'one dev-client build per fingerprint per Mac',
  () => {
    it('runs one build when two runtime processes miss the same fingerprint at once', async () => {
      const counter = join(box.dir, 'builds-run')
      const command = fakeBuildCommand('build/Pod.app', counter, 'sleep 0.5')
      const roots = [await worktree(box, 'wt-a', null), await worktree(box, 'wt-b', null)]
      const startAt = String(Date.now() + 1_500)
      const runs = await Promise.all(
        roots.map((root) =>
          runProcess({
            program: NODE,
            args: [worker, box.home.root, root, command, startAt],
            timeoutMs: 60_000
          })
        )
      )
      for (const run of runs) {
        expect(run.stderr).toBe('')
        expect(run.code).toBe(0)
      }
      const answers = runs.map((run) => JSON.parse(run.stdout))
      expect(answers[0].buildId).toBe(answers[1].buildId)
      expect(answers.map((answer) => answer.started).sort()).toEqual([false, true])
      expect(answers.map((answer) => answer.state)).toEqual(['done', 'done'])
      expect((await readFile(counter, 'utf8')).trim().split('\n')).toHaveLength(1)
      expect(existsSync(join(box.home.root, 'clients', BUNDLE, 'f00d.app', 'Info.plist'))).toBe(
        true
      )
    }, 60_000)
  }
)
