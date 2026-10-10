import { describe, expect, it } from 'vitest'
import {
  buildSandboxClaudeConfig,
  buildSandboxHookScript,
  buildSandboxManagedSettings,
  provisionSandbox,
  resolveSandboxMounts,
  VERIFY_AND_INSTALL_CLAUDE
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

describe('sandbox Claude config', () => {
  it('trusts only the mounted worktree', () => {
    expect(JSON.parse(buildSandboxClaudeConfig('/Users/me/web.worktrees/a'))).toEqual({
      projects: { '/Users/me/web.worktrees/a': { hasTrustDialogAccepted: true } }
    })
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

  const release = { version: '2.1.295', platform: 'linux-arm64', dir: '/cache/2.1.295/linux-arm64' }

  it('creates an isolated machine with only the mounts, then installs the verified Claude and the hooks', async () => {
    const { run, calls } = recorder()
    const result = await provisionSandbox({
      run,
      name: 'pod-web-1a2b3c4d-sbx',
      mounts: ['/Users/me/web.worktrees/a', '/Users/me/web/.git'],
      release
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
    expect(calls.find((call) => call.args[0] === 'push')?.args).toEqual([
      'push',
      '-m',
      'pod-web-1a2b3c4d-sbx',
      '/cache/2.1.295/linux-arm64/claude',
      '/cache/2.1.295/linux-arm64/manifest.json',
      '/cache/2.1.295/linux-arm64/manifest.json.sig',
      '/cache/2.1.295/linux-arm64/release-key.gpg',
      '/var/tmp/pod-claude-release/'
    ])
    const verify = calls.find((call) => call.args.includes(VERIFY_AND_INSTALL_CLAUDE))
    expect(verify?.args.slice(-4)).toEqual([
      '2.1.295',
      'linux-arm64',
      '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
      '/var/tmp/pod-claude-release'
    ])
    expect(calls.some((call) => call.args.join(' ').includes('install.sh'))).toBe(false)
    const writes = calls.filter((call) => call.input !== undefined)
    expect(writes.map((call) => call.args.at(-1))).toEqual([
      'claude-hook.sh',
      expect.stringContaining('.claude.json'),
      expect.stringContaining('/etc/claude-code/managed-settings.json')
    ])
    expect(writes[0]?.input).toContain('host.orb.internal')
    expect(writes[1]?.input).toContain('"/Users/me/web.worktrees/a"')
    expect(writes[1]?.input).not.toContain('.git"')
  })

  it('verifies the signature and checksum before installing anything', () => {
    const gpgv = VERIFY_AND_INSTALL_CLAUDE.indexOf('gpgv --status-fd 1')
    const checksum = VERIFY_AND_INSTALL_CLAUDE.indexOf('sha256sum --check')
    const install = VERIFY_AND_INSTALL_CLAUDE.indexOf('install -m 755')
    expect(VERIFY_AND_INSTALL_CLAUDE.startsWith('set -eu\n')).toBe(true)
    expect(gpgv).toBeGreaterThan(0)
    expect(checksum).toBeGreaterThan(gpgv)
    expect(install).toBeGreaterThan(checksum)
    expect(VERIFY_AND_INSTALL_CLAUDE).toContain('VALIDSIG .* $fingerprint\\$')
  })

  it('fails when the installed Claude reports another version', async () => {
    const { run } = recorder()
    await expect(
      provisionSandbox({
        run,
        name: 'pod-x-sbx',
        mounts: ['/Users/me/x'],
        release: { ...release, version: '2.1.296' }
      })
    ).rejects.toThrow('claude --version: expected 2.1.296, got 2.1.295 (Claude Code)')
  })

  it('reports the failing step', async () => {
    const { run } = recorder('root')
    await expect(
      provisionSandbox({ run, name: 'pod-x-sbx', mounts: ['/Users/me/x'], release })
    ).rejects.toThrow('install git: E: unable to fetch')
  })

  it('skips Claude without a release (E2E stand-in agents)', async () => {
    const { run, calls } = recorder()
    const result = await provisionSandbox({
      run,
      name: 'pod-x-sbx',
      mounts: ['/Users/me/x'],
      release: null
    })
    expect(result).toEqual({ agentVersion: null })
    expect(calls.some((call) => call.args[0] === 'push')).toBe(false)
  })
})
