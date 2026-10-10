import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { ACC_STATE_DIR, type AccLifecycleOutcome } from './acc-lifecycle'
import { ACC_LIFECYCLE_RECORD, accLifecycleRecord } from './acc-lifecycle-record'
import { startPodAccSupervisor } from './acc-supervisor'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function result(code: number | null, timedOut = false): ProcessResult {
  return { code, signal: null, stdout: '', stderr: '', timedOut }
}

/** An installed Pod.app with a 1.31.2 payload, and an account whose owner.json already names it. */
function installedPod() {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-record-'))
  roots.push(root)
  const home = join(root, 'home')
  const app = join(root, 'Pod.app')
  const payload = join(app, 'Contents/Resources/claude-acc')
  const state = join(home, ACC_STATE_DIR)
  mkdirSync(payload, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(payload, 'VERSION'), '1.31.2\n')
  writeFileSync(join(payload, 'setup.sh'), '#!/bin/bash\n')
  const owner = `${JSON.stringify({ owner: 'pod', version: '1.31.2', app, at: 1791626064 })}\n`
  writeFileSync(join(state, 'owner.json'), owner)
  const profile = join(home, 'Library/Application Support/Pod')
  return {
    app,
    owner,
    state,
    record: join(state, ACC_LIFECYCLE_RECORD),
    start: (env: NodeJS.ProcessEnv = {}) => {
      const run = vi.fn(async (_spec: ProcessSpec) => result(1))
      const log = vi.fn()
      const supervisor = startPodAccSupervisor({
        config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
        resourcesPath: join(app, 'Contents/Resources'),
        execPath: join(app, 'Contents/MacOS/Pod'),
        home,
        accountHome: home,
        userDataPath: profile,
        defaultUserDataPath: profile,
        platform: 'darwin',
        env,
        run,
        setTrayYield: () => {},
        syncTray: () => {},
        log
      })
      return { supervisor, run, log }
    }
  }
}

describe('pod-lifecycle.json', () => {
  it('records an up-to-date launch, which leaves owner.json alone', async () => {
    // test2 relaunched at 17:46:59 on 2026-10-10: owner.json stayed at 11:54:24 and nothing said why
    const pod = installedPod()
    const { supervisor, run, log } = pod.start()
    await expect(supervisor.lifecycle).resolves.toMatchObject({ status: 'up-to-date' })
    supervisor.stop()
    expect(log).toHaveBeenCalledWith('claude-acc: 1.31.2 is installed')
    expect(run.mock.calls.every(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(true)
    expect(readFileSync(join(pod.state, 'owner.json'), 'utf8')).toBe(pod.owner)
    const record: unknown = JSON.parse(readFileSync(pod.record, 'utf8'))
    expect(record).toEqual({
      version: 1,
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      pid: process.pid,
      app: pod.app,
      payload: '1.31.2',
      status: 'up-to-date',
      reason: null,
      from: null,
      exit: null,
      timedOut: false,
      message: null
    })
    expect(existsSync(`${pod.record}.tmp`)).toBe(false)
  })

  it("never writes from a harness launch, and keeps the installed app's record", async () => {
    const pod = installedPod()
    writeFileSync(pod.record, '{"status":"up-to-date"}\n')
    const { supervisor } = pod.start({ ORCA_E2E_HEADLESS: '1' })
    await expect(supervisor.lifecycle).resolves.toMatchObject({ status: 'skipped' })
    supervisor.stop()
    expect(readFileSync(pod.record, 'utf8')).toBe('{"status":"up-to-date"}\n')
  })

  it('keeps what an install came from and how setup.sh ended', () => {
    const from = { owner: 'pod', version: '1.31.2', app: '/Applications/Pod.app' }
    const outcome: AccLifecycleOutcome = {
      status: 'failed',
      decision: { action: 'install', reason: 'version-changed', version: '1.31.5', from },
      result: result(null, true),
      message: ''
    }
    const context = { app: '/Applications/Pod.app', at: new Date(0), pid: 7 }
    expect(accLifecycleRecord(outcome, context)).toMatchObject({
      at: '1970-01-01T00:00:00.000Z',
      payload: '1.31.5',
      status: 'failed',
      reason: 'version-changed',
      from,
      exit: null,
      timedOut: true,
      message: null
    })
    const busy: AccLifecycleOutcome = { status: 'busy', decision: outcome.decision }
    expect(accLifecycleRecord(busy, context)).toBeNull()
  })
})
