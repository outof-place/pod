import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import { createManagedCommandMatcher, type HooksConfig } from '../../agent-hooks/installer-utils'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { ClaudeHookService } from '../../claude/hook-service'
import { applyManagedHooks, CLAUDE_HOOK_SETTINGS } from '../../claude/hook-settings'
import {
  getPodAgentHookInstallPath,
  installPodAgentHookBinary,
  podAgentHookEntry,
  podManagedClaudeHook,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'

let home = ''
let bundled = ''
const claude = { agent: 'claude', settings: CLAUDE_HOOK_SETTINGS }
const SCRIPT = '/unused/claude-hook.sh'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pod-agent-hook-'))
  homedirMock.mockReturnValue(home)
  bundled = join(home, 'bundled-pod-agent-hook')
  writeFileSync(bundled, '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
  setPlatform(realPlatform)
})

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    writable: true
  })
}

function managedCommands(config: HooksConfig, event: string): string[] {
  return (config.hooks?.[event] ?? []).flatMap((definition) =>
    (definition.hooks ?? []).map((hook) => hook.command)
  )
}

describe('pod-agent-hook, the native managed Claude hook', () => {
  it('is found in the app bundle or, in a checkout, through POD_AGENT_HOOK_BINARY', () => {
    const resources = join(home, 'Resources')
    expect(
      resolveBundledPodAgentHook({ platform: 'darwin', env: {}, resourcesPath: resources })
    ).toBe(null)
    expect(
      resolveBundledPodAgentHook({
        platform: 'darwin',
        env: { POD_AGENT_HOOK_BINARY: bundled },
        resourcesPath: resources
      })
    ).toBe(bundled)
    expect(
      resolveBundledPodAgentHook({ platform: 'linux', env: { POD_AGENT_HOOK_BINARY: bundled } })
    ).toBe(null)
  })

  it('runs in exec form from Claude 2.1.139, copied beside claude-hook.sh', () => {
    const hook = podManagedClaudeHook(claude, SCRIPT, { claudeVersion: '2.1.296' }, true, bundled)
    const installPath = join(home, '.orca', 'agent-hooks', 'pod-agent-hook')
    expect(hook).toEqual({ type: 'command', command: installPath, args: [], timeout: 10 })
    expect(readFileSync(installPath, 'utf8')).toBe(readFileSync(bundled, 'utf8'))
    expect(statSync(installPath).mode & 0o777).toBe(0o755)
  })

  it('keeps the shell entry for an older or unknown Claude, another agent, or no client', () => {
    for (const [service, version, client] of [
      [claude, '2.1.138', bundled],
      [claude, undefined, bundled],
      [{ ...claude, agent: 'openclaude' }, '2.1.296', bundled],
      [claude, '2.1.296', null]
    ] as const) {
      const hook = podManagedClaudeHook(service, SCRIPT, { claudeVersion: version }, true, client)
      expect(hook.command, String(version)).not.toContain('pod-agent-hook')
      expect(hook.args).toBeUndefined()
    }
  })

  it('counts the native entry as installed in a status check, which carries no version', () => {
    expect(podManagedClaudeHook(claude, SCRIPT, {}, false, bundled).command).not.toContain(
      'pod-agent-hook'
    )
    podManagedClaudeHook(claude, SCRIPT, { claudeVersion: '2.1.296' }, true, bundled)
    expect(podManagedClaudeHook(claude, SCRIPT, {}, false, bundled)).toEqual(
      podAgentHookEntry(getPodAgentHookInstallPath())
    )
  })

  it('leaves an identical client alone, and replaces a stale one through a rename', () => {
    const installPath = getPodAgentHookInstallPath()
    expect(installPodAgentHookBinary(bundled, installPath)).toBe(true)
    const first = statSync(installPath)
    expect(installPodAgentHookBinary(bundled, installPath)).toBe(true)
    expect(statSync(installPath).ino).toBe(first.ino)
    writeFileSync(bundled, '#!/bin/sh\necho new\n')
    expect(installPodAgentHookBinary(bundled, installPath)).toBe(true)
    expect(statSync(installPath).ino).not.toBe(first.ino)
    expect(readFileSync(installPath, 'utf8')).toContain('new')
  })

  it("is one of Claude's managed entries, and no other agent's", () => {
    const command = getPodAgentHookInstallPath()
    expect(createManagedCommandMatcher('claude-hook.sh')(command)).toBe(true)
    expect(createManagedCommandMatcher('openclaude-hook.sh')(command)).toBe(false)
  })

  it('replaces the shell entries once, keeps async, and then writes nothing', () => {
    const plan = getClaudeManagedHookPlan('2.1.296')
    const shell = podManagedClaudeHook(claude, SCRIPT, { claudeVersion: '2.1.100' }, true, bundled)
    const native = podManagedClaudeHook(claude, SCRIPT, { claudeVersion: '2.1.296' }, true, bundled)
    const user = {
      matcher: 'Bash',
      hooks: [{ type: 'command' as const, command: 'rtk hook claude' }]
    }
    const before = applyManagedHooks(
      { hooks: { PreToolUse: [user] } },
      shell,
      'claude-hook.sh',
      plan
    )
    const upgraded = applyManagedHooks(before, native, 'claude-hook.sh', plan)
    expect(managedCommands(upgraded, 'PreToolUse')).toEqual(['rtk hook claude', native.command])
    expect(upgraded.hooks?.PreToolUse?.[1]?.hooks?.[0]?.async).toBe(true)
    expect(upgraded.hooks?.SessionStart?.[0]?.hooks?.[0]).toEqual(native)
    const again = applyManagedHooks(upgraded, native, 'claude-hook.sh', plan)
    expect(JSON.stringify(again)).toBe(JSON.stringify(upgraded))
    const downgraded = applyManagedHooks(upgraded, shell, 'claude-hook.sh', plan)
    expect(managedCommands(downgraded, 'PreToolUse')).toEqual(['rtk hook claude', shell.command])
  })

  it('installs through the hook service, and a second install leaves settings.json as it is', () => {
    vi.stubEnv('POD_AGENT_HOOK_BINARY', bundled)
    // Why: the client ships for macOS only; elsewhere (Linux CI) the service keeps the script.
    setPlatform('darwin')
    const service = new ClaudeHookService()
    const settingsPath = join(home, '.claude', 'settings.json')
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    const written = readFileSync(settingsPath, 'utf8')
    const config: HooksConfig = JSON.parse(written)
    expect(managedCommands(config, 'Stop')).toEqual([getPodAgentHookInstallPath()])
    const mtime = statSync(settingsPath).mtimeMs
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(written)
    expect(statSync(settingsPath).mtimeMs).toBe(mtime)
    expect(service.getStatus().state).toBe('installed')
  })
})
