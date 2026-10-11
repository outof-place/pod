import { describe, expect, it } from 'vitest'
import type { HookCommandConfig, HookDefinition, HooksConfig } from '../agent-hooks/installer-utils'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'
import { applyManagedHooks } from './hook-settings'

const SCRIPT_FILE_NAME = 'claude-hook.sh'
const MANAGED_COMMAND = '/home/dev/.orca/agent-hooks/claude-hook.sh'
const managedHook: HookCommandConfig = { type: 'command', command: MANAGED_COMMAND, timeout: 10 }
const STATUS_ONLY = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop'
]

function install(config: HooksConfig, claudeVersion: string | undefined): HooksConfig {
  return applyManagedHooks(
    config,
    managedHook,
    SCRIPT_FILE_NAME,
    getClaudeManagedHookPlan(claudeVersion)
  )
}

function managedAsync(config: HooksConfig): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(config.hooks ?? {}).flatMap(([event, definitions]) =>
      definitions.flatMap((definition) =>
        (definition.hooks ?? [])
          .filter((hook) => hook.command === MANAGED_COMMAND)
          .map((hook) => [event, hook.async === true])
      )
    )
  )
}

describe("Orca's Claude status hooks in the background", () => {
  it('runs the status-only events async from 2.1.19, and the answering ones in line', () => {
    const written = managedAsync(install({ hooks: {} }, '2.1.296'))
    for (const event of STATUS_ONLY) {
      expect(written[event], event).toBe(true)
    }
    expect(written.SessionStart).toBe(false)
    expect(written.SessionEnd).toBe(false)
    expect(written.PermissionRequest).toBe(false)
  })

  it('writes no async for a Claude that would wait for it anyway', () => {
    const written = managedAsync(install({ hooks: {} }, '2.1.18'))
    expect(Object.values(written).some(Boolean)).toBe(false)
  })

  it('leaves the file as it is when it already says the same, user entries and order included', () => {
    const userTool: HookDefinition = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'rtk hook claude' }]
    }
    const first = install({ hooks: { PreToolUse: [userTool] } }, '2.1.296')
    // a user entry after Orca's: an identical install must not move Orca's to the end
    const settled: HooksConfig = {
      ...first,
      hooks: { ...first.hooks, PreToolUse: [...(first.hooks?.PreToolUse ?? []), userTool] }
    }
    const again = install(settled, '2.1.296')
    expect(JSON.stringify(again)).toBe(JSON.stringify(settled))
  })

  it('adds async to an entry Orca wrote without it, once Claude runs it', () => {
    const plain = install({ hooks: {} }, '2.1.18')
    expect(managedAsync(install(plain, '2.1.296')).PostToolUse).toBe(true)
  })

  it('keeps whatever async is written when the version is unknown', () => {
    const withAsync = install({ hooks: {} }, '2.1.296')
    expect(managedAsync(install(withAsync, undefined)).PostToolUse).toBe(true)
    const without = install({ hooks: {} }, '2.1.18')
    expect(managedAsync(install(without, undefined)).PostToolUse).toBe(false)
  })
})
