import { describe, expect, it } from 'vitest'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { createPodClaudeOldTerminalMethods } from './pod-claude-old-terminal-rpc-methods'

function ask(
  deps: Parameters<typeof createPodClaudeOldTerminalMethods>[0],
  terminal = 'term-1'
): { openedBefore: boolean } {
  const [method] = createPodClaudeOldTerminalMethods(deps)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deps stand in for every runtime call the handler makes.
  return method.handler({ terminal }, { runtime: {} } as never) as { openedBefore: boolean }
}

describe('pod.terminal.openedBeforeClaudeAccounts', () => {
  const pane = { ptyId: 'pty-7' }

  it("answers true only for a live pane on a daemon without the claude function, whose System default isn't the selected account", () => {
    const base = {
      ptyIdOf: (terminal: string) => (terminal === 'term-1' ? pane.ptyId : null),
      onLegacyDaemon: (ptyId: string) => ptyId === 'pty-7',
      systemDefaultRunsAnotherAccount: () => true
    }
    expect(ask(base)).toEqual({ openedBefore: true })
    expect(ask(base, 'gone')).toEqual({ openedBefore: false })
    expect(ask({ ...base, onLegacyDaemon: () => false })).toEqual({ openedBefore: false })
    // No account selected (null) or the same login: nothing to say.
    expect(ask({ ...base, systemDefaultRunsAnotherAccount: () => null })).toEqual({
      openedBefore: false
    })
    expect(ask({ ...base, systemDefaultRunsAnotherAccount: () => false })).toEqual({
      openedBefore: false
    })
  })

  it('is advertised, so a client asks only a host that has it', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.terminal.opened-before-claude-accounts.v1')
  })
})
