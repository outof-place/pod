import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { ACC_STATE_DIR } from './acc-lifecycle'
import {
  ACC_ROOTD_REQUEST,
  accRootdConfirmDialog,
  answerAccRootdRequest,
  readAccRootdStep,
  takeAccRootdRequest
} from './acc-rootd'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const NOW = new Date(1_760_000_000_000)

/** A home whose $STATE holds `body` as the request, written the way AccKit writes it (0600). */
function home(body: unknown, mode = 0o600): { home: string; request: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-rootd-'))
  roots.push(root)
  const state = join(root, ACC_STATE_DIR)
  mkdirSync(state, { recursive: true })
  const request = join(state, ACC_ROOTD_REQUEST)
  if (body !== undefined) {
    writeFileSync(request, JSON.stringify(body), { mode })
    chmodSync(request, mode)
  }
  return { home: root, request }
}

describe('pod-rootd requests from the panel', () => {
  it('takes a fresh enable request of this account', () => {
    const at = NOW.getTime() / 1000 - 30
    const { home: h, request } = home({ action: 'enable', at })
    expect(takeAccRootdRequest(h, NOW)).toEqual({ ok: true, at })
    expect(existsSync(request)).toBe(false)
    expect(takeAccRootdRequest(h, NOW)).toBeNull()
  })

  it.each([
    ['a stale one', { action: 'enable', at: NOW.getTime() / 1000 - 6 * 60 }, 0o600],
    ['one from the future', { action: 'enable', at: NOW.getTime() / 1000 + 120 }, 0o600],
    ['another action', { action: 'disable', at: NOW.getTime() / 1000 }, 0o600],
    ['one without a time', { action: 'enable' }, 0o600],
    ['one others can write', { action: 'enable', at: NOW.getTime() / 1000 }, 0o620]
  ])('refuses and removes %s', (_name, body, mode) => {
    const { home: h, request } = home(body, mode)
    expect(takeAccRootdRequest(h, NOW)).toMatchObject({ ok: false })
    expect(existsSync(request)).toBe(false)
  })

  it("refuses a request another account's process could have left", () => {
    const { home: h } = home({ action: 'enable', at: NOW.getTime() / 1000 })
    expect(takeAccRootdRequest(h, NOW, (process.getuid?.() ?? 0) + 1)).toEqual({
      ok: false,
      reason: "not a regular file of this account's"
    })
  })

  it('never follows a symlink, and leaves its target alone', () => {
    const { home: h, request } = home(undefined)
    const target = join(h, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ action: 'enable', at: NOW.getTime() / 1000 }), {
      mode: 0o600
    })
    symlinkSync(target, request)
    expect(takeAccRootdRequest(h, NOW)).toEqual({ ok: false, reason: 'not a regular file' })
    expect(existsSync(target)).toBe(true)
  })

  it('finds nothing when no one asked', () => {
    expect(takeAccRootdRequest(home(undefined).home, NOW)).toBeNull()
  })
})

const PAYLOAD = '/Applications/Pod.app/Contents/Resources/claude-acc'

/** pod-rootctl answering `service status --json` with `status`, every other command with `code`. */
function rootctl(status: Partial<ProcessResult> | Error, code = 0) {
  return vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    const done = { code, signal: null, stdout: '', stderr: '', timedOut: false }
    if (spec.args?.join(' ') !== 'service status --json') {
      return done
    }
    if (status instanceof Error) {
      throw status
    }
    return { ...done, code: 0, ...status }
  })
}

describe("pod-rootd's step from pod-rootctl", () => {
  it.each(['install', 'approve', 'ready'] as const)('reads %s', async (step) => {
    const run = rootctl({ stdout: `{"step": "${step}"}\n` })
    await expect(readAccRootdStep(run, PAYLOAD)).resolves.toBe(step)
    expect(run).toHaveBeenCalledWith({
      program: `${PAYLOAD}/pod-rootctl`,
      args: ['service', 'status', '--json'],
      timeoutMs: 10_000
    })
  })

  it.each([
    ['an exit other than 0', { code: 69, stdout: '{"step": "ready"}' }],
    ['no JSON', { stdout: 'ready\n' }],
    ['a step it does not know', { stdout: '{"step": "upgrade"}' }],
    ['no step', { stdout: '[]' }],
    ['no pod-rootctl', new Error('ENOENT')]
  ] as const)('says nothing for %s', async (_name, status) => {
    await expect(readAccRootdStep(rootctl(status), PAYLOAD)).resolves.toBeNull()
  })
})

describe('answering a pod-rootd request', () => {
  it('does nothing once the helper is ready', async () => {
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => '')
    const run = rootctl({ stdout: '{"step": "ready"}' })
    await expect(
      answerAccRootdRequest({ run, payloadDir: PAYLOAD, confirm, openPath })
    ).resolves.toEqual({
      outcome: 'registered',
      step: 'ready'
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
  })

  it.each([
    [true, '', 'registered'],
    [true, 'No application knows how to open it', 'unavailable'],
    [false, '', 'declined']
  ] as const)('install, Pod asks %s: Installer says "%s"', async (yes, opened, outcome) => {
    const confirm = vi.fn(async () => yes)
    const openPath = vi.fn(async () => opened)
    const run = rootctl({ stdout: '{"step": "install"}' })
    await expect(
      answerAccRootdRequest({ run, payloadDir: PAYLOAD, confirm, openPath })
    ).resolves.toEqual({
      outcome,
      step: 'install'
    })
    expect(confirm).toHaveBeenCalledExactlyOnceWith('install')
    expect(openPath.mock.calls).toEqual(yes ? [[`${PAYLOAD}/pod-rootd.pkg`]] : [])
    // Pod never installs or registers it itself
    expect(run).toHaveBeenCalledOnce()
  })

  it.each([
    [0, 'registered'],
    [1, 'unavailable']
  ] as const)('approve: Login Items through pod-rootctl, which exits %i', async (code, outcome) => {
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => '')
    const run = rootctl({ stdout: '{"step": "approve"}' }, code)
    await expect(
      answerAccRootdRequest({ run, payloadDir: PAYLOAD, confirm, openPath })
    ).resolves.toEqual({
      outcome,
      step: 'approve'
    })
    expect(confirm).toHaveBeenCalledExactlyOnceWith('approve')
    expect(run).toHaveBeenLastCalledWith({
      program: `${PAYLOAD}/pod-rootctl`,
      args: ['service', 'open-settings'],
      timeoutMs: 10_000
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('declines without a way to ask, and is unavailable when pod-rootctl says nothing', async () => {
    const openPath = vi.fn(async () => '')
    await expect(
      answerAccRootdRequest({
        run: rootctl({ stdout: '{"step": "install"}' }),
        payloadDir: PAYLOAD,
        openPath
      })
    ).resolves.toEqual({ outcome: 'declined', step: 'install' })
    const confirm = vi.fn(async () => true)
    await expect(
      answerAccRootdRequest({ run: rootctl({ code: 69 }), payloadDir: PAYLOAD, confirm, openPath })
    ).resolves.toEqual({ outcome: 'unavailable' })
    expect(confirm).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each(['install', 'approve'] as const)('asks with Cancel as the default (%s)', (step) => {
    const dialog = accRootdConfirmDialog(step)
    expect(dialog.buttons?.[dialog.defaultId ?? -1]).toBe('Cancel')
    expect(dialog.cancelId).toBe(dialog.defaultId)
  })
})
