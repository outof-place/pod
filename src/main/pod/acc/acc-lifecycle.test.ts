import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import {
  ACC_STATE_DIR,
  AUTOMATED_LAUNCH_ENV,
  accSetupSpec,
  automatedLaunchEnv,
  decideAccLifecycle,
  runAccLifecycle,
  setupHomeRefusal,
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
  const profile = join(home, 'Library/Application Support/Pod')
  return {
    platform: 'darwin',
    home,
    accountHome: home,
    userDataPath: profile,
    defaultUserDataPath: profile,
    payloadDir,
    appPath: APP
  }
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
    ['turned off', { mode: 'off' }, { action: 'skip', reason: 'disabled' }],
    ['turned off with 0', { mode: '0' }, { action: 'skip', reason: 'disabled' }],
    [
      'a harness launched Pod',
      { automatedBy: 'ORCA_E2E_HEADLESS' },
      { action: 'skip', reason: 'automated-launch' }
    ],
    [
      'HOME is not the account home',
      { accountHome: '/Users/the-real-account' },
      { action: 'skip', reason: 'home-override' }
    ],
    [
      'the account home is unknown',
      { accountHome: null },
      { action: 'skip', reason: 'home-override' }
    ],
    [
      'Pod runs another profile',
      { userDataPath: '/private/tmp/bench/userData' },
      { action: 'skip', reason: 'custom-profile' }
    ],
    [
      'the build has no default profile',
      { defaultUserDataPath: null },
      { action: 'skip', reason: 'custom-profile' }
    ]
  ])('skips when %s', (_name, override, expected) => {
    // no owner.json: each of these would otherwise be a first install
    expect(decideAccLifecycle({ ...fixture(), ...override })).toEqual(expected)
  })

  it.each(AUTOMATED_LAUNCH_ENV)('treats %s as a harness launch', (name) => {
    expect(automatedLaunchEnv({ [name]: '1' })).toBe(name)
  })

  it('treats a plain or empty environment as a user launch', () => {
    expect(automatedLaunchEnv({})).toBeNull()
    expect(automatedLaunchEnv({ ORCA_BACKGROUND_LAUNCH: '' })).toBeNull()
  })

  it('keeps a v1 payload on its own app and launchd agents', () => {
    const input = fixture()
    const args = accSetupSpec(input).args ?? []
    expect(args[args.indexOf('--app') + 1]).toBe(join(input.payloadDir, 'Claude Acc.app'))
    expect(args).not.toContain('--pod-agents')
    expect(args).not.toContain('--python')
  })

  it("hands a v2 payload Pod's services, menu helper and Python", () => {
    const input = { ...fixture(), appPath: join(roots.at(-1) ?? '', 'Pod.app') }
    writeFileSync(join(input.payloadDir, 'pod-acc-run'), '')
    const python = join(input.appPath, 'Contents/Resources/python/bin/python3')
    expect(accSetupSpec(input).args).not.toContain('--python')
    mkdirSync(join(python, '..'), { recursive: true })
    writeFileSync(python, '')
    const args = accSetupSpec(input).args ?? []
    expect(args[args.indexOf('--app') + 1]).toBe(
      join(input.appPath, 'Contents/Library/LoginItems/Pod Menu.app')
    )
    expect(args.slice(-3)).toEqual(['--pod-agents', '--python', python])
  })

  it('refuses at the spawn a setup.sh whose HOME is not the account home', () => {
    const input = fixture()
    expect(setupHomeRefusal(input, accSetupSpec(input))).toBeNull()
    const foreign = { ...accSetupSpec(input), env: { HOME: '/private/tmp/bench-home' } }
    expect(setupHomeRefusal(input, foreign)).toContain('/private/tmp/bench-home')
    expect(
      setupHomeRefusal({ ...input, accountHome: '/Users/other' }, accSetupSpec(input))
    ).toContain('not the account home')
    expect(setupHomeRefusal({ ...input, accountHome: null }, accSetupSpec(input))).toBe(
      'the account home is unknown'
    )
  })

  it.each([
    [3, 'claude-acc belongs to another owner'],
    [4, 'HOME is not the account home']
  ])('takes setup.sh exit %i as a refusal, not a failed install', async (code, reason) => {
    const input = fixture()
    await expect(runAccLifecycle(input, fakeSetup(input, code))).resolves.toMatchObject({
      status: 'refused',
      message: expect.stringContaining(reason)
    })
  })

  it('never runs setup.sh from a throwaway HOME', async () => {
    const input = { ...fixture(), accountHome: '/Users/the-real-account' }
    const run = fakeSetup(input)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({
      status: 'skipped',
      decision: { action: 'skip', reason: 'home-override' }
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('skips without a payload', () => {
    expect(decideAccLifecycle(fixture({ version: null }))).toEqual({
      action: 'skip',
      reason: 'no-payload'
    })
  })

  it.each([
    ['first-install', null],
    ['version-changed', { owner: 'pod', version: '1.26.0', app: APP }],
    ['app-moved', { owner: 'pod', version: '1.27.0', app: '/Users/me/Downloads/Pod.app' }]
  ])('installs on %s', (reason, owner) => {
    expect(decideAccLifecycle(fixture({ owner }))).toMatchObject({
      action: 'install',
      reason,
      version: '1.27.0'
    })
  })

  it.each(['brew', 'none'])('stays out once claude-acc was handed to %s', (owner) => {
    expect(decideAccLifecycle(fixture({ owner: { owner, version: '1.27.0', app: APP } }))).toEqual({
      action: 'skip',
      reason: 'handed-back'
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

  it("installs a 1.31 payload's Pod Menu.app as the menu helper", async () => {
    const input = fixture()
    mkdirSync(join(input.payloadDir, 'Pod Menu.app', 'Contents'), { recursive: true })
    const run = fakeSetup(input)
    await expect(runAccLifecycle(input, run)).resolves.toMatchObject({ status: 'installed' })
    const args = run.mock.calls[0]![0].args ?? []
    expect(args[args.indexOf('--app') + 1]).toBe(join(input.payloadDir, 'Pod Menu.app'))
    // the v1 setup path: launchd agents in ~/Library/LaunchAgents, never Pod's SMAppService ones
    expect(args).not.toContain('--pod-agents')
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
