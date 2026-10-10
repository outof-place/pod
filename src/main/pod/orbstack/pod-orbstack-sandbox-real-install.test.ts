// Fork-only (Pod): downloads a real Claude Code release and installs it in a real OrbStack sandbox.
// Opt-in: POD_E2E_ORBSTACK=1. Creates and deletes one pod-*-sbx machine; touches no other machine.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { podOrbstackMachineName } from './pod-orbstack-recipe'
import { provisionSandbox } from './pod-orbstack-sandbox'
import { createOrbstackToolRunner, resolveOrbstackToolPaths } from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK === '1'

describe.skipIf(!enabled)('real OrbStack sandbox Claude install', () => {
  it('verifies the signed release in the VM and trusts only the worktree', async () => {
    const run = createOrbstackToolRunner(() => resolveOrbstackToolPaths())
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'pod-sbx-install-')))
    const name = podOrbstackMachineName('e2e-install', worktree, 'sandbox')
    expect((await run('orb', ['info', name, '--format', 'json'])).code).not.toBe(0)
    const cacheRoot = mkdtempSync(join(tmpdir(), 'pod-claude-releases-'))
    const cache = createClaudeReleaseCache({
      root: cacheRoot,
      fetcher: (url, init) => fetch(url, init),
      platform: () => sandboxClaudePlatform()
    })
    try {
      const release = await cache.prepare(null)
      const { agentVersion } = await provisionSandbox({ run, name, mounts: [worktree], release })
      expect(agentVersion).toBe(release.version)
      const config = await run('orb', ['run', '-m', name, 'sh', '-c', 'cat "$HOME/.claude.json"'])
      expect(JSON.parse(config.stdout)).toEqual({
        projects: { [worktree]: { hasTrustDialogAccepted: true } }
      })
      const leftovers = await run('orb', ['run', '-m', name, 'ls', '/var/tmp'])
      expect(leftovers.stdout).not.toContain('pod-claude-release')
    } finally {
      await run('orb', ['delete', '--force', name], { timeoutMs: 120_000 })
      rmSync(cacheRoot, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 600_000)
})
