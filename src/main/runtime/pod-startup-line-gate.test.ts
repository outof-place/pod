import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPromptNeedsPasteError } from '../../shared/pod-agent-prompt-needs-paste'
import { assertLocalStartupLineTypeable } from './pod-startup-line-gate'
import { mapRuntimeError } from './rpc/errors'

const MULTI_LINE = `claude 'one\ntwo'`

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pod-startup-line-gate-'))
  vi.stubEnv('TMPDIR', directory)
  vi.stubEnv('SHELL', '/bin/zsh')
})

afterEach(() => {
  vi.unstubAllEnvs()
  chmodSync(directory, 0o700)
  rmSync(directory, { recursive: true, force: true })
})

function check(args: Partial<Parameters<typeof assertLocalStartupLineTypeable>[0]>): unknown {
  try {
    assertLocalStartupLineTypeable({
      command: MULTI_LINE,
      launchAgent: undefined,
      isRemote: false,
      ...args
    })
    return null
  } catch (error) {
    return error
  }
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('assertLocalStartupLineTypeable', () => {
  it('names the shell the spawn picks: the request, then the setting, then SHELL', () => {
    expect(check({})).toBeNull()
    expect(check({ shellOverride: '/bin/ksh' })).toBeInstanceOf(AgentPromptNeedsPasteError)
    expect(check({ defaultShellSetting: '/bin/tcsh' })).toBeInstanceOf(AgentPromptNeedsPasteError)
    expect(check({ shellOverride: '/bin/bash', defaultShellSetting: '/bin/ksh' })).toBeNull()
    vi.stubEnv('SHELL', '/usr/bin/mksh')
    expect(check({})).toBeInstanceOf(AgentPromptNeedsPasteError)
  })

  it('answers over RPC with the code and the reason', () => {
    const error = check({ shellOverride: '/bin/ksh', command: 'a'.repeat(600) })
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: {
        code: 'agent_prompt_needs_paste',
        message: 'agent_prompt_needs_paste',
        data: { reason: 'line-too-long' }
      }
    })
  })

  it('passes an agent line in any shell while its script can be written, leaving no file', () => {
    expect(check({ launchAgent: 'claude', shellOverride: '/bin/ksh' })).toBeNull()
    expect(check({ launchAgent: 'claude', shellOverride: '/bin/tcsh' })).toBeNull()
    expect(readdirSync(directory)).toEqual([])
  })

  it('refuses an agent line that needs staging when the script directory cannot be written', () => {
    chmodSync(directory, 0o500)
    expect(check({ launchAgent: 'claude' })).toMatchObject({ data: { reason: 'multi-line' } })
    expect(check({ launchAgent: 'claude', command: `claude 'fix it'` })).toBeNull()
  })

  it('leaves a remote host and an empty command alone', () => {
    expect(check({ isRemote: true, shellOverride: '/bin/ksh' })).toBeNull()
    expect(check({ command: undefined, shellOverride: '/bin/ksh' })).toBeNull()
  })
})
