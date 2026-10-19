import './mock-descendant-sweep'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('relay startup command staging', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let stagingDir: string

  beforeEach(() => {
    stagingDir = mkdtempSync(join(tmpdir(), 'orca-relay-staging-'))
    vi.stubEnv('TMPDIR', stagingDir)
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    vi.unstubAllEnvs()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  async function spawn(command: string): Promise<unknown> {
    return await dispatcher.callRequest('pty.spawn', {
      command,
      commandDelivery: 'provider',
      env: { SHELL: '/bin/zsh' }
    })
  }

  it('types a short provider-delivered command as is', async () => {
    await spawn('echo short')
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPtySpawn.mock.results[0]?.value.write).toHaveBeenCalledWith('echo short\r')
  })

  it('stages a long provider-delivered command and types only the sourcing line', async () => {
    const command = `claude '${'x'.repeat(600)}'`
    await spawn(command)
    const [script] = readdirSync(stagingDir)
    const scriptPath = join(stagingDir, script)
    expect(readFileSync(scriptPath, 'utf8').split('\n')[1]).toBe(command)
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPtySpawn.mock.results[0]?.value.write).toHaveBeenCalledWith(`. '${scriptPath}'\r`)
  })

  it('deletes a script the shell never sourced when the PTY exits', async () => {
    await spawn(`claude '${'x'.repeat(600)}'`)
    const scriptPath = join(stagingDir, readdirSync(stagingDir)[0])
    mockPtyInstance.onExit.mock.calls.at(-1)?.[0]?.({ exitCode: 0 })
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('stages nothing for a renderer-delivered command it only holds as a hint', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: `claude '${'x'.repeat(600)}'`,
      env: { SHELL: '/bin/zsh' }
    })
    expect(readdirSync(stagingDir)).toEqual([])
  })

  // Pod: the relay follows the local hosts; a line that needs staging is never typed in full.
  function terminalOutput(): string {
    return dispatcher._notifications
      .filter((notification) => notification.method === 'pty.data')
      .map((notification) => String(notification.params?.data))
      .join('')
  }

  it('types nothing, and says why, when it cannot stage a line that needs it', async () => {
    vi.stubEnv('TMPDIR', join(stagingDir, 'missing'))
    await spawn(`claude '${'x'.repeat(600)}'`)
    await vi.advanceTimersByTimeAsync(1600)
    expect(mockPtySpawn.mock.results[0]?.value.write).not.toHaveBeenCalled()
    expect(terminalOutput()).toContain(
      '[orca] Did not type the launch command: it is over 512 bytes, and staging it failed (ENOENT'
    )
  })

  it('types nothing for a multi-line command in a shell that cannot source a script', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: `echo 'one\ntwo'`,
      commandDelivery: 'provider',
      env: { SHELL: '/bin/ksh' }
    })
    await vi.advanceTimersByTimeAsync(1600)
    expect(mockPtySpawn.mock.results[0]?.value.write).not.toHaveBeenCalled()
    expect(readdirSync(stagingDir)).toEqual([])
    expect(terminalOutput()).toContain(
      'it has more than one line, and this shell cannot run it staged'
    )
  })

  it('answers pty.startupLineRefusal the way pty.spawn decides, before any PTY', async () => {
    const ask = (params: Record<string, unknown>) =>
      dispatcher.callRequest('pty.startupLineRefusal', params)
    const multiLine = `echo 'one\ntwo'`
    expect(await ask({ command: multiLine, env: { SHELL: '/bin/ksh' } })).toEqual({
      reason: 'multi-line'
    })
    expect(await ask({ command: multiLine, env: { SHELL: '/bin/zsh' } })).toEqual({ reason: null })
    expect(
      await ask({ command: multiLine, launchAgent: 'claude', env: { SHELL: '/bin/ksh' } })
    ).toEqual({ reason: null })
    expect(await ask({ command: 'echo short', env: { SHELL: '/bin/ksh' } })).toEqual({
      reason: null
    })
    expect(await ask({})).toEqual({ reason: null })
    expect(readdirSync(stagingDir)).toEqual([])
    vi.stubEnv('TMPDIR', join(stagingDir, 'missing'))
    expect(await ask({ command: multiLine, env: { SHELL: '/bin/zsh' } })).toEqual({
      reason: 'multi-line'
    })
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })
})
