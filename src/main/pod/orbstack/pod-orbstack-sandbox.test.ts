import { describe, expect, it } from 'vitest'
import {
  buildSandboxHookScript,
  buildSandboxManagedSettings,
  provisionSandbox,
  resolveSandboxMounts
} from './pod-orbstack-sandbox'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

describe('sandbox hook files', () => {
  it('points the generated hook script at the Mac through host.orb.internal', () => {
    const script = buildSandboxHookScript()
    expect(script).toContain('http://host.orb.internal:${ORCA_AGENT_HOOK_PORT}/hook/claude')
    expect(script).toContain('--noproxy "host.orb.internal"')
    expect(script).not.toContain('127.0.0.1')
  })

  it('registers the managed hook for the installed Claude and turns off its updater', () => {
    const settings = JSON.parse(buildSandboxManagedSettings('2.1.295'))
    expect(settings.env).toEqual({ DISABLE_AUTOUPDATER: '1' })
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']) {
      expect(JSON.stringify(settings.hooks[event]), event).toContain('claude-hook.sh')
    }
  })
})

describe('resolveSandboxMounts', () => {
  it('adds the git dir only when it lives outside the worktree', async () => {
    expect(await resolveSandboxMounts('/Users/me/web', async () => '.git')).toEqual([
      '/Users/me/web'
    ])
    expect(
      await resolveSandboxMounts('/Users/me/web.worktrees/a', async () => '/Users/me/web/.git')
    ).toEqual(['/Users/me/web.worktrees/a', '/Users/me/web/.git'])
    expect(await resolveSandboxMounts('/Users/me/notes', async () => null)).toEqual([
      '/Users/me/notes'
    ])
  })
})

describe('provisionSandbox', () => {
  function recorder(failOn?: string) {
    const calls: { args: readonly string[]; input?: string }[] = []
    const run: OrbstackToolRunner = async (tool, args, options) => {
      calls.push({ args, ...(options?.input ? { input: options.input } : {}) })
      const ok: OrbstackToolResult = { code: 0, stdout: '', stderr: '', timedOut: false }
      if (failOn && args.includes(failOn)) {
        return { ...ok, code: 1, stderr: 'E: unable to fetch' }
      }
      if (args.join(' ').includes('--version')) {
        return { ...ok, stdout: '2.1.295 (Claude Code)\n' }
      }
      expect(tool).toBe('orb')
      return ok
    }
    return { run, calls }
  }

  it('creates an isolated machine with only the mounts, then installs Claude and the hooks', async () => {
    const { run, calls } = recorder()
    const result = await provisionSandbox({
      run,
      name: 'pod-web-1a2b3c4d-sbx',
      mounts: ['/Users/me/web.worktrees/a', '/Users/me/web/.git'],
      claudeVersion: '2.1.295'
    })

    expect(result).toEqual({ agentVersion: '2.1.295' })
    expect(calls[0]?.args).toEqual([
      'create',
      '--isolated',
      '--mount',
      '/Users/me/web.worktrees/a:/Users/me/web.worktrees/a',
      '--mount',
      '/Users/me/web/.git:/Users/me/web/.git',
      'ubuntu:24.04',
      'pod-web-1a2b3c4d-sbx'
    ])
    const install = calls.find((call) => call.args.join(' ').includes('install.sh'))
    expect(install?.args.at(-1)).toBe('2.1.295')
    const writes = calls.filter((call) => call.input !== undefined)
    expect(writes.map((call) => call.args.at(-1))).toEqual([
      'claude-hook.sh',
      expect.stringContaining('/etc/claude-code/managed-settings.json')
    ])
    expect(writes[0]?.input).toContain('host.orb.internal')
  })

  it('reports the failing step', async () => {
    const { run } = recorder('root')
    await expect(
      provisionSandbox({ run, name: 'pod-x-sbx', mounts: ['/Users/me/x'], claudeVersion: null })
    ).rejects.toThrow('install git: E: unable to fetch')
  })

  it('skips the Claude download when asked (E2E stand-in agents)', async () => {
    const { run, calls } = recorder()
    const result = await provisionSandbox({
      run,
      name: 'pod-x-sbx',
      mounts: ['/Users/me/x'],
      claudeVersion: null,
      skipAgentInstall: true
    })
    expect(result).toEqual({ agentVersion: null })
    expect(calls.some((call) => call.args.join(' ').includes('install.sh'))).toBe(false)
  })
})
