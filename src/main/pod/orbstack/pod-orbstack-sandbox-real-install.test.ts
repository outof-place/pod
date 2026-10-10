// Fork-only (Pod): downloads a real Claude Code release and installs it in a real OrbStack sandbox.
// Opt-in: POD_E2E_ORBSTACK=1. Creates and deletes one pod-*-sbx machine; touches no other machine.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { createSandboxRelays } from './pod-orbstack-relay'
import { podOrbstackMachineName } from './pod-orbstack-recipe'
import { provisionSandbox } from './pod-orbstack-sandbox'
import { createOrbstackToolRunner, resolveOrbstackToolPaths } from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK === '1'

async function orbProcesses(machine: string, pattern = `-m ${machine}`): Promise<string[]> {
  const result = await runProcess({ program: 'pgrep', args: ['-fl', '--', pattern] })
  return result.stdout.split('\n').filter((line) => line.includes('orb'))
}

const relayProcesses = (machine: string) => orbProcesses(machine, `-m ${machine} -u root python3`)

async function settled(read: () => Promise<string[]>): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = await read()
    if (found.length === 0) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return read()
}

describe.skipIf(!enabled)('real OrbStack sandbox', () => {
  it('verifies the signed release, trusts only the worktree and reaches the Mac only via the relay', async () => {
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

      const hookServer = createServer((socket) =>
        socket.end('HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello')
      )
      await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve))
      const address: AddressInfo | string | null = hookServer.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const curl = (...args: string[]) =>
        run('orb', ['run', '-m', name, 'curl', '-sS', '-m', '5', ...args], { timeoutMs: 30_000 })
      // --isolate-network: the Mac's loopback is out of reach until the relay serves the port.
      expect((await curl(`http://host.orb.internal:${port}/`)).code).not.toBe(0)
      const orb = resolveOrbstackToolPaths().orb ?? 'orb'
      const relays = createSandboxRelays({
        spawnAgent: (machine, args) =>
          spawnProcess({ program: orb, args: ['-m', machine, '-u', 'root', 'python3', ...args] })
      })
      try {
        const route = {
          vmPort: port,
          hostPort: port,
          hookToken: 'server-token',
          authorize: (token: string) => token === 'sandbox-token'
        }
        expect(await relays.ensure(name, route).ready).toBe(true)
        const hook = (path: string, token: string) =>
          curl(
            '-X',
            'POST',
            '-H',
            `X-Orca-Agent-Hook-Token: ${token}`,
            '--data-binary',
            '{}',
            '-o',
            '/dev/null',
            '-w',
            '%{http_code}',
            `http://127.0.0.1:${port}${path}`
          )
        expect((await hook('/hook/claude', 'sandbox-token')).stdout).toBe('200')
        expect((await hook('/hook/claude', 'server-token')).stdout).toBe('403')
        expect((await hook('/anything', 'sandbox-token')).stdout).toBe('403')
        // A Pod crash closes the relay's stdin; the orb client must not outlive it.
        const orphan = spawnProcess({
          program: orb,
          args: ['-m', name, '-u', 'root', 'python3', '-c', 'import sys; sys.stdin.read()']
        })
        const exited = new Promise<boolean>((resolve) => orphan.on('exit', () => resolve(true)))
        orphan.stdin.end()
        expect(
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000, false))])
        ).toBe(true)
      } finally {
        relays.stopAll()
        hookServer.close()
      }
      expect(await settled(() => relayProcesses(name))).toEqual([])
    } finally {
      await run('orb', ['delete', '--force', name], { timeoutMs: 120_000 })
      expect(await settled(() => orbProcesses(name))).toEqual([])
      expect((await run('orb', ['list', '--quiet'])).stdout.split('\n')).not.toContain(name)
      rmSync(cacheRoot, { recursive: true, force: true })
      rmSync(worktree, { recursive: true, force: true })
    }
  }, 600_000)
})
