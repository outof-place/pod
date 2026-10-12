import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import { removeInheritedTerminalSessionEnv } from './terminal-session-env'

describe('removeInheritedTerminalSessionEnv', () => {
  it("drops Terminal.app's session id and zsh's session variables", () => {
    const env: Record<string, string> = {
      TERM_SESSION_ID: 'w0t0p0:4253ACE2',
      SHELL_SESSION_FILE: '/Users/u/.zsh_sessions/4253ACE2.session',
      SHELL_SESSION_DID_INIT: '1',
      PATH: '/bin'
    }
    removeInheritedTerminalSessionEnv(env)
    expect(env).toEqual({ PATH: '/bin' })
  })
})

describe('daemon PTY environment', () => {
  afterEach(() => vi.unstubAllEnvs())

  it("doesn't hand a Terminal.app session to Pod's terminals", () => {
    vi.stubEnv('TERM_SESSION_ID', 'w0t0p0:4253ACE2')
    vi.stubEnv('SHELL_SESSION_FILE', '/Users/u/.zsh_sessions/4253ACE2.session')
    const env = createDaemonPtyEnvironment({ sessionId: 's', cols: 80, rows: 24 })
    expect(env).not.toHaveProperty('TERM_SESSION_ID')
    expect(env).not.toHaveProperty('SHELL_SESSION_FILE')
  })
})
