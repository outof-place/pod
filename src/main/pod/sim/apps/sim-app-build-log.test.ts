// A build log read while its build runs: claude-acc's queue wait from its start line, and each step
// counted once however the runtime's snapshot and its reconcile overlap on one build.
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSimBuildProgress } from './sim-app-build-log'
import { SIM_BUILD_WAITING_FOR_MEMORY } from './sim-app-build-records'

let dir: string
let build: { buildId: string; logPath: string }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pod-sim-build-log-'))
  build = { buildId: 'sb_app_f00d_test', logPath: join(dir, 'build.log') }
  await writeFile(build.logPath, '# Pod dev-client build\n$ npx expo run:ios\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('reading a build log', () => {
  it('holds a build for memory until claude-acc’s start line, and keeps how long it waited', async () => {
    const reader = createSimBuildProgress()
    await appendFile(build.logPath, '[sched] czeka: waiting for 14.3 GB, 0.0 free\n')
    expect(await reader.advance(build)).toMatchObject({ phase: SIM_BUILD_WAITING_FOR_MEMORY })
    await appendFile(build.logPath, '[sched] start po 1h05m czekania, local\n')
    const started = await reader.advance(build)
    expect(started.phase).toBeUndefined()
    expect(started.queuedMs).toBe(65 * 60_000)
    await appendFile(build.logPath, '[sched] a later note\n› Compiling app\n')
    expect(await reader.advance(build)).toMatchObject({ steps: 1, phase: 'Compiling app' })
  })

  it('counts each line once when two reads of one build overlap', async () => {
    const reader = createSimBuildProgress()
    await reader.advance(build)
    await appendFile(build.logPath, '› Compiling a\n› Compiling b\n')
    await Promise.all([reader.advance(build), reader.advance(build)])
    await appendFile(build.logPath, '[sched] start po 2m54s czekania, local\n› Compiling c\n')
    const seen = await reader.advance(build)
    expect(seen).toMatchObject({ steps: 3, phase: 'Compiling c', queuedMs: 174_000 })
  })
})
