import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import {
  ACC_STATE_DIR,
  decideAccLifecycle,
  runAccLifecycle,
  type AccLifecycleInput
} from './acc-lifecycle'

const APP = '/Applications/Pod.app'
const roots: string[] = []

function fixture(
  options: { version?: string | null; owner?: object | null } = {}
): AccLifecycleInput {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-lifecycle-'))
  roots.push(root)
  const home = join(root, 'home')
  const payloadDir = join(root, 'Pod.app/Contents/Resources/claude-acc')
  mkdirSync(join(home, ACC_STATE_DIR), { recursive: true })
  mkdirSync(payloadDir, { recursive: true })
  if (options.version !== null) {
    writeFileSync(join(payloadDir, 'VERSION'), `${options.version ?? '1.27.0'}\n`)
    writeFileSync(join(payloadDir, 'setup.sh'), '#!/bin/bash\n')
  }
  if (options.owner) {
    writeFileSync(join(home, ACC_STATE_DIR, 'owner.json'), JSON.stringify(options.owner))
  }
  return { platform: 'darwin', home, payloadDir, appPath: APP }
}

/** A setup.sh that does what the real one does on success: writes owner.json. */
function fakeSetup(input: AccLifecycleInput, code = 0, writeOwner = true) {
  return vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    const args = spec.args ?? []
    if (code === 0 && writeOwner) {
      writeFileSync(
        join(input.home, ACC_STATE_DIR, 'owner.json'),
        JSON.stringify({
          owner: 'pod',
          version: '1.27.0',
          app: args[args.indexOf('--owner-app') + 1]
        })
      )
    }
    return {
      code,
      signal: null,
      stdout: 'gotowe\n',
      stderr: code ? 'błąd: coś\n' : '',
      timedOut: false
    }
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('claude-acc lifecycle', () => {
  it.each([
    ['not darwin', { platform: 'linux' as const }, { action: 'skip', reason: 'not-darwin' }],
    ['turned off', { mode: 'off' }, { action: 'skip', reason: 'disabled' }]
  ])('skips when %s', (_name, override, expected) => {
    expect(decideAccLifecycle({ ...fixture(), ...override })).toEqual(expected)
  })

  it('skips without a payload', () => {
    expect(decideAccLifecycle(fixture({ version: null }))).toEqual({
      action: 'skip',
      reason: 'no-payload'
    })
  })

  it.each([
    ['first-install', null],
    ['owner-changed', { owner: 'brew', version: '1.27.0', app: APP }],
    ['version-changed', { owner: 'pod', version: '1.26.0', app: APP }],
    ['app-moved', { owner: 'pod', version: '1.27.0', app: '/Users/me/Downloads/Pod.app' }]
  ])('installs on %s', (reason, owner) => {
    expect(decideAccLifecycle(fixture({ owner }))).toMatchObject({
      action: 'install',
      reason,
      version: '1.27.0'
    })
  })

  it('leaves a matching install alone', async () => {
    const input = fixture({ owner: { owner: 'pod', version: '1.27.0', app: APP } })
    const run = fakeSetup(input)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({ status: 'up-to-date' })
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the payload setup.sh as Pod and is idempotent afterwards', async () => {
    const input = fixture()
    const run = fakeSetup(input)
    const outcome = await runAccLifecycle(input, run)
    expect(outcome.status).toBe('installed')
    const spec = run.mock.calls[0]![0]
    const p = (name: string): string => join(input.payloadDir, name)
    expect([spec.program, ...(spec.args ?? [])]).toEqual([
      '/bin/bash',
      p('setup.sh'),
      '--app',
      p('Claude Acc.app'),
      '--fanctl',
      p('fanctl'),
      '--hook',
      p('claude-acc-hook'),
      '--desktop',
      p('claude-acc-desktop'),
      '--owner',
      'pod',
      '--owner-app',
      APP
    ])
    expect(spec.env?.HOME).toBe(input.home)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({ status: 'up-to-date' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('dry run reports the command and runs nothing', async () => {
    const input = { ...fixture(), mode: 'dry-run' }
    const run = fakeSetup(input)
    const outcome = await runAccLifecycle(input, run)
    expect(outcome.status).toBe('dry-run')
    expect(outcome.status === 'dry-run' && outcome.spec.args?.at(-1)).toBe(APP)
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['setup.sh fails', 1, true],
    ['setup.sh exits 0 but writes no owner.json', 0, false]
  ])('reports failure when %s', async (_name, code, writeOwner) => {
    const input = fixture()
    const outcome = await runAccLifecycle(input, fakeSetup(input, code, writeOwner))
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' && outcome.message).toBe(code ? 'błąd: coś' : 'gotowe')
  })

  it('never runs two setups at once, and takes over a stale lock', async () => {
    const input = fixture()
    const lock = join(input.home, ACC_STATE_DIR, 'pod-setup.lock')
    writeFileSync(lock, '999')
    const run = fakeSetup(input)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({ status: 'busy' })
    expect(run).not.toHaveBeenCalled()
    const old = (Date.now() - 11 * 60_000) / 1000
    utimesSync(lock, old, old)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({ status: 'installed' })
  })
})
