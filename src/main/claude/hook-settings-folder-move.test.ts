import { describe, expect, it } from 'vitest'
import type { HookCommandConfig, HookDefinition, HooksConfig } from '../agent-hooks/installer-utils'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'
import { applyManagedHooks, getPosixManagedScriptFileName } from './hook-settings'

// Why placeholder folders: the managed hooks move from one home folder to another (the decouple),
// and the matcher goes by `agent-hooks/<script>`, whatever folder holds it.
const OLD_HOOK = '/Users/u/.legacy-home/agent-hooks/pod-agent-hook'
const NEW_HOOK = '/Users/u/.product-home/agent-hooks/pod-agent-hook'
const plan = getClaudeManagedHookPlan('2.1.296')
const managed: HookCommandConfig = { type: 'command', command: NEW_HOOK }

const foreign = (args: string, extra: Partial<HookCommandConfig> = {}): HookCommandConfig => ({
  type: 'command',
  command: `/Users/u/.local/libexec/native-hooks/memory-hook ${args}`,
  async: true,
  ...extra
})

/** A settings.json the way the user's looks: the old managed entries among the user's own. */
function userSettings(): HooksConfig {
  const hooks: Record<string, HookDefinition[]> = {}
  for (const event of plan.install) {
    hooks[event.eventName] = [
      { ...event.definition, hooks: [{ type: 'command', command: OLD_HOOK, async: event.async }] }
    ]
  }
  const list = (event: string) => (hooks[event] ??= [])
  list('PostToolUse').unshift({ matcher: '*', hooks: [foreign('post-tool-use', { timeout: 5 })] })
  list('SessionStart').push({ hooks: [foreign('session-start')] })
  // One group holding both: the user's entry must stay where it is, without the managed one.
  list('Stop').unshift({
    hooks: [{ type: 'command', command: OLD_HOOK, async: true }, foreign('stop')]
  })
  hooks.Notification = [{ matcher: 'idle', hooks: [foreign('notify')] }]
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    permissions: { allow: ['Bash(git status:*)'], defaultMode: 'acceptEdits' },
    hooks,
    statusLine: { type: 'command', command: '/Users/u/.claude/statusline.sh', padding: 0 },
    enabledPlugins: { 'memory@market': true },
    alwaysThinkingEnabled: true
  }
}

const isManaged = (hook: HookCommandConfig) => hook.command.endsWith('/pod-agent-hook')

/** The file without any managed entry, as the writer serializes it. */
function withoutManaged(config: HooksConfig): string {
  const hooks: Record<string, HookDefinition[]> = {}
  for (const [event, definitions] of Object.entries(config.hooks ?? {})) {
    const kept = (definitions ?? []).flatMap((definition) => {
      const rest = (definition.hooks ?? []).filter((hook) => !isManaged(hook))
      return rest.length > 0 ? [{ ...definition, hooks: rest }] : []
    })
    if (kept.length > 0) {
      hooks[event] = kept
    }
  }
  return `${JSON.stringify({ ...config, hooks }, null, 2)}\n`
}

describe('managed Claude hooks moving to another home folder', () => {
  it('replaces every old entry and leaves the rest of settings.json byte for byte', () => {
    const before = userSettings()
    const after = applyManagedHooks(before, managed, getPosixManagedScriptFileName(), plan)

    expect(JSON.stringify(after)).not.toContain(OLD_HOOK)
    expect(withoutManaged(after)).toBe(withoutManaged(before))
    expect(Object.keys(after)).toEqual(Object.keys(before))
    for (const event of plan.install) {
      const entries = (after.hooks?.[event.eventName] ?? []).flatMap((d) => d.hooks ?? [])
      expect(entries.filter(isManaged), event.eventName).toEqual([
        event.async ? { ...managed, async: true } : managed
      ])
    }
  })

  it('writes nothing more once the entries point at the new folder', () => {
    const once = applyManagedHooks(userSettings(), managed, getPosixManagedScriptFileName(), plan)
    const twice = applyManagedHooks(once, managed, getPosixManagedScriptFileName(), plan)
    expect(`${JSON.stringify(twice, null, 2)}\n`).toBe(`${JSON.stringify(once, null, 2)}\n`)
  })
})
