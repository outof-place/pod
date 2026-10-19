// Fork-only (Pod): the refusal reads the same on every route a guarded agent write takes.
import { describe, expect, it } from 'vitest'
import { readAgentForegroundRefusal } from './pod-agent-foreground-refusal'

describe('readAgentForegroundRefusal', () => {
  it.each([
    ['a runtime error', new Error('agent_not_in_foreground: shell'), 'shell'],
    [
      'an IPC rejection',
      new Error(
        "Error invoking remote method 'pty:writeAccepted': Error: agent_not_in_foreground: group_changed"
      ),
      'group_changed'
    ],
    ['a string', 'terminal_guard_no_agent: agent_not_in_foreground: not_agent', 'not_agent'],
    ['the bare code', new Error('agent_not_in_foreground'), 'unknown']
  ])('reads %s', (_what, error, reason) => {
    expect(readAgentForegroundRefusal(error)).toBe(reason)
  })

  it.each([new Error('terminal_not_writable'), null, undefined, 42])(
    'is null for anything else (%s)',
    (error) => {
      expect(readAgentForegroundRefusal(error)).toBeNull()
    }
  )
})
