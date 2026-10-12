import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { applyManagedHooks, getStatusLineScriptFileName } from '../../claude/hook-settings'
import { podAgentHookEntry, POD_AGENT_HOOK_FILE_NAME } from './pod-agent-hook-native'
import {
  POD_CLAUDE_FLAG_SETTINGS_FIRST_VERSION,
  POD_CLAUDE_HTTP_HOOK_EVENTS,
  podClaudeFlagSettings,
  podClaudeFlagSettingsFiles,
  podStatusLineCommand
} from './pod-claude-flag-settings'

const HOME = '/Users/e2e'
const CLIENT = `${HOME}/.orca/agent-hooks/${POD_AGENT_HOOK_FILE_NAME}`
const relay = { url: 'http://127.0.0.1:41234/hook/claude', token: 'tok' }

describe('the settings Pod hands Claude with --settings', () => {
  it('is, without a relay, exactly the plan settings.json gets for that Claude', () => {
    for (const version of [POD_CLAUDE_FLAG_SETTINGS_FIRST_VERSION, '2.1.400']) {
      const plan = getClaudeManagedHookPlan(version)
      const written = applyManagedHooks({}, podAgentHookEntry(CLIENT), 'claude-hook.sh', plan)
      expect(podClaudeFlagSettings({ home: HOME }), version).toEqual({ hooks: written.hooks })
    }
  })

  it('sends the measured events to the relay and keeps the rest on pod-agent-hook', () => {
    const { hooks } = podClaudeFlagSettings({ home: HOME, relay })
    const http = Object.entries(hooks)
      .filter(([, groups]) => groups[0].hooks[0].type === 'http')
      .map(([event]) => event)
    expect(http.sort()).toEqual([...POD_CLAUDE_HTTP_HOOK_EVENTS].sort())
    expect(hooks.SessionStart[0].hooks[0]).toMatchObject({ type: 'command', command: CLIENT })
    expect(hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [
        {
          type: 'http',
          url: relay.url,
          timeout: 2,
          headers: {
            'X-Pod-Token': 'tok',
            'X-Pod-Session': '$POD_DAEMON_SESSION',
            'X-Pod-Agent-Process': '$POD_AGENT_PROCESS',
            'X-Pod-Job-Dir': '$CLAUDE_JOB_DIR'
          },
          allowedEnvVars: ['POD_DAEMON_SESSION', 'POD_AGENT_PROCESS', 'CLAUDE_JOB_DIR']
        }
      ]
    })
  })

  it("carries settings.json's native statusLine only in the statusLine variant", () => {
    expect(podStatusLineCommand()).toBe(podStatusLineCommand(getStatusLineScriptFileName()))
    expect(podClaudeFlagSettings({ home: HOME }).statusLine).toBeUndefined()
    expect(podClaudeFlagSettings({ home: HOME, statusLine: true }).statusLine).toEqual({
      type: 'command',
      command: podStatusLineCommand()
    })
    const files = podClaudeFlagSettingsFiles(
      { home: HOME },
      { hooks: 'a.json', statusLine: 'b.json' }
    )
    expect(JSON.parse(files['a.json'])).toEqual(podClaudeFlagSettings({ home: HOME }))
    expect(JSON.parse(files['b.json'])).toEqual(
      podClaudeFlagSettings({ home: HOME, statusLine: true })
    )
  })
})
