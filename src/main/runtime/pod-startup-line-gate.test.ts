import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveMultiplexerMock } = vi.hoisted(() => ({ getActiveMultiplexerMock: vi.fn() }))

vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

import { AgentPromptNeedsPasteError } from '../../shared/pod-agent-prompt-needs-paste'
import { buildDaemonChildEnv } from '../daemon/daemon-launched-child-spawn'
import { resolvePtyShellPath } from '../daemon/shell-ready'
import { nameLocalTypedLineShell } from './agent-launch-typed-line-shell'
import {
  assertStartupLineTypeable,
  RELAY_STARTUP_LINE_REFUSAL_METHOD
} from './pod-startup-line-gate'
import { mapRuntimeError } from './rpc/errors'

const MULTI_LINE = `claude 'one\ntwo'`

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pod-startup-line-gate-'))
  vi.stubEnv('TMPDIR', directory)
  vi.stubEnv('SHELL', '/bin/zsh')
  getActiveMultiplexerMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  chmodSync(directory, 0o700)
  rmSync(directory, { recursive: true, force: true })
})

async function check(
  args: Partial<Parameters<typeof assertStartupLineTypeable>[0]>
): Promise<unknown> {
  try {
    await assertStartupLineTypeable({ command: MULTI_LINE, launchAgent: undefined, ...args })
    return null
  } catch (error) {
    return error
  }
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('assertStartupLineTypeable on this host', () => {
  it('names the shell the spawn picks: the request, then the setting, then SHELL', async () => {
    expect(await check({})).toBeNull()
    expect(await check({ shellOverride: '/bin/ksh' })).toBeInstanceOf(AgentPromptNeedsPasteError)
    expect(await check({ defaultShellSetting: '/bin/tcsh' })).toBeInstanceOf(
      AgentPromptNeedsPasteError
    )
    expect(await check({ shellOverride: '/bin/bash', defaultShellSetting: '/bin/ksh' })).toBeNull()
    vi.stubEnv('SHELL', '/usr/bin/mksh')
    expect(await check({})).toBeInstanceOf(AgentPromptNeedsPasteError)
  })

  // Why: the daemon is forked with main's env, and the runtime spawn hands it the setting as its
  // shell override, so its `override || env.SHELL || process.env.SHELL` lands where the gate does.
  it.each([
    [undefined, '/bin/ksh'],
    ['/bin/tcsh', '/bin/zsh'],
    [undefined, '/bin/zsh']
  ])('names the shell the daemon spawns (setting %s, SHELL %s)', (setting, shell) => {
    vi.stubEnv('SHELL', shell)
    const daemonEnv = buildDaemonChildEnv({ userDataPath: directory })
    vi.stubEnv('SHELL', daemonEnv.SHELL)
    const daemonShell = setting || resolvePtyShellPath({})
    expect(
      nameLocalTypedLineShell({
        isRemote: false,
        ...(setting ? { defaultShellSetting: setting } : {})
      })
    ).toBe(basename(daemonShell))
  })

  it('answers over RPC with the code and the reason', async () => {
    const error = await check({ shellOverride: '/bin/ksh', command: 'a'.repeat(600) })
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: {
        code: 'agent_prompt_needs_paste',
        message: 'agent_prompt_needs_paste',
        data: { reason: 'line-too-long' }
      }
    })
  })

  it('passes an agent line in any shell while its script can be written, leaving no file', async () => {
    expect(await check({ launchAgent: 'claude', shellOverride: '/bin/ksh' })).toBeNull()
    expect(await check({ launchAgent: 'claude', shellOverride: '/bin/tcsh' })).toBeNull()
    expect(readdirSync(directory)).toEqual([])
  })

  it('refuses an agent line that needs staging when the script directory cannot be written', async () => {
    chmodSync(directory, 0o500)
    expect(await check({ launchAgent: 'claude' })).toMatchObject({
      data: { reason: 'multi-line' }
    })
    expect(await check({ launchAgent: 'claude', command: `claude 'fix it'` })).toBeNull()
  })

  it('leaves an empty command alone', async () => {
    expect(await check({ command: undefined, shellOverride: '/bin/ksh' })).toBeNull()
  })
})

describe('assertStartupLineTypeable on an SSH host', () => {
  function relayAnswering(answer: () => Promise<unknown>) {
    const request = vi.fn(answer)
    getActiveMultiplexerMock.mockReturnValue({ request })
    return request
  }

  it('asks nothing for a line that needs no staging', async () => {
    expect(await check({ connectionId: 'ssh-1', command: `claude 'fix it'` })).toBeNull()
    expect(getActiveMultiplexerMock).not.toHaveBeenCalled()
  })

  it("asks the relay, with the spawn's agent and SHELL, and follows its answer", async () => {
    const request = relayAnswering(async () => ({ reason: null }))
    expect(
      await check({ connectionId: 'ssh-1', launchAgent: 'claude', envShell: '/bin/ksh' })
    ).toBeNull()
    expect(getActiveMultiplexerMock).toHaveBeenCalledWith('ssh-1')
    expect(request).toHaveBeenCalledWith(RELAY_STARTUP_LINE_REFUSAL_METHOD, {
      command: MULTI_LINE,
      launchAgent: 'claude',
      env: { SHELL: '/bin/ksh' }
    })

    relayAnswering(async () => ({ reason: 'multi-line' }))
    expect(await check({ connectionId: 'ssh-1' })).toMatchObject({
      code: 'agent_prompt_needs_paste',
      data: { reason: 'multi-line' }
    })
  })

  it('fails closed for a relay from before the check, an odd answer, plain SSH, or no connection', async () => {
    relayAnswering(async () => {
      throw Object.assign(new Error(`Method not found: ${RELAY_STARTUP_LINE_REFUSAL_METHOD}`), {
        code: -32601
      })
    })
    expect(await check({ connectionId: 'ssh-1' })).toMatchObject({ data: { reason: 'multi-line' } })

    relayAnswering(async () => ({ reason: 'something-else' }))
    expect(await check({ connectionId: 'ssh-1' })).toMatchObject({ data: { reason: 'multi-line' } })

    getActiveMultiplexerMock.mockReturnValue(undefined)
    expect(await check({ connectionId: 'ssh-1', command: 'a'.repeat(600) })).toMatchObject({
      data: { reason: 'line-too-long' }
    })

    getActiveMultiplexerMock.mockImplementation(() => {
      throw new Error('ssh_active_multiplexer_resolver_not_installed')
    })
    expect(await check({ connectionId: 'ssh-1' })).toBeInstanceOf(AgentPromptNeedsPasteError)
  })
})
