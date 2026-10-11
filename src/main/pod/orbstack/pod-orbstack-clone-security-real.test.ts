// Fork-only (Pod): sandboxes cloned from one template share no per-sandbox material. Opt-in:
// POD_E2E_ORBSTACK=1 (real OrbStack, one Claude Code download). Creates and deletes only machines it
// records; `orb list` holds none of them afterwards.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { POD_ORBSTACK_BUILTIN_RECIPE, podOrbstackMachineName } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createSandboxRelays } from './pod-orbstack-relay'
import { createSandboxAccess } from './pod-orbstack-sandbox-access'
import { createPodOrbstackTemplates } from './pod-orbstack-templates'
import { createOrbstackToolRunner, resolveOrbstackToolPaths } from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK === '1'

// What a template must not hold; each line prints only when the thing exists.
const TEMPLATE_PROBE = `
for f in "$HOME/.claude" "$HOME/.claude.json" "$HOME/.orca" /etc/pod-sandbox /etc/claude-code /run/pod-sandbox-relay; do
  [ -e "$f" ] && echo "present $f"
done
grep -q 'pod-sandbox-relay' /etc/hosts && echo 'present hosts pin'
ls /etc/ssh/ssh_host_* 2>/dev/null | sed 's/^/present /'
true`

// Per-sandbox material after a launch's relay is up.
const MATERIAL_PROBE = `
echo "machine-id $(cat /etc/machine-id)"
echo "ca $(sha256sum /etc/pod-sandbox/anthropic-ca.pem 2>/dev/null | cut -c1-64)"
for key in /etc/ssh/ssh_host_*_key.pub; do [ -e "$key" ] && echo "hostkey $(sha256sum "$key" | cut -c1-64)"; done
true`

describe.skipIf(!enabled)('real OrbStack template clones', () => {
  it('builds a template with no credentials, and clones that share nothing per sandbox', async () => {
    const paths = () => resolveOrbstackToolPaths()
    const orb = paths().orb ?? 'orb'
    const run = createOrbstackToolRunner(paths)
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pod-test-clones-')))
    const registry = new PodOrbstackRegistry(join(scratch, 'registry.json'))
    const templates = createPodOrbstackTemplates({ run, file: join(scratch, 'templates.json') })
    const cache = createClaudeReleaseCache({
      root: join(scratch, 'releases'),
      fetcher: (url, init) => fetch(url, init),
      platform: () => sandboxClaudePlatform()
    })
    const machines = createPodOrbstackMachines({
      paths,
      run,
      registry,
      templates,
      loadRecipe: () => POD_ORBSTACK_BUILTIN_RECIPE,
      prepareClaudeRelease: () => cache.prepare(process.env.POD_E2E_ORBSTACK_CLAUDE ?? null)
    })
    const relays = createSandboxRelays({
      spawnAgent: (machine, args) =>
        spawnProcess({ program: orb, args: ['-m', machine, '-u', 'root', 'python3', ...args] })
    })
    const access = createSandboxAccess({ relays })
    setPodSandboxAnthropicCredentials({ mode: () => 'oauth', authHeaders: async () => null })
    const hookServer = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve))
    const address: AddressInfo | string | null = hookServer.address()
    const hook = { port: typeof address === 'object' && address ? address.port : 0, token: 't' }
    const probe = 'pod-test-template-probe'
    const created: string[] = [probe]
    const sandbox = (label: string) => {
      const path = realpathSync(mkdtempSync(join(scratch, `${label}-`)))
      const worktreeId = `clones-${label}::${path}`
      return { worktreeId, worktreePath: path, displayName: label }
    }
    const exec = async (machine: string, script: string) =>
      (await run('orb', ['run', '-m', machine, 'sh', '-c', script], { timeoutMs: 60_000 })).stdout
    try {
      const a = sandbox('a')
      const b = sandbox('b')
      expect(await machines.createSandbox(a)).toEqual({ ok: true })
      expect(await machines.createSandbox(b)).toEqual({ ok: true })
      const [template] = templates.list()
      expect(template).toMatchObject({ kind: 'sandbox', state: 'ready' })
      created.push(template?.name ?? '')

      // The template itself stays stopped and sealed; a bare clone shows exactly what it holds.
      expect((await run('orb', ['clone', template?.name ?? '', probe])).code).toBe(0)
      expect((await run('orb', ['start', probe])).code).toBe(0)
      expect((await exec(probe, TEMPLATE_PROBE)).trim()).toBe('')

      const names = [a, b].map((target) =>
        podOrbstackMachineName(target.worktreeId, target.worktreePath, 'sandbox')
      )
      created.push(...names)
      // A launch starts the sandbox's relay, which writes its CA and pins the API host.
      const launches = names.map((name) => access.start(name, hook))
      for (const [index, name] of names.entries()) {
        const wait = `for i in $(seq 150); do [ "$(cat /run/pod-sandbox-relay/ready 2>/dev/null)" = ${launches[index]?.nonce} ] && exit 0; sleep 0.1; done; exit 1`
        expect(
          (await run('orb', ['run', '-m', name, 'sh', '-c', wait], { timeoutMs: 30_000 })).code
        ).toBe(0)
      }
      const material = await Promise.all(names.map((name) => exec(name, MATERIAL_PROBE)))
      const [left = '', right = ''] = material
      const lines = (text: string) =>
        text
          .trim()
          .split('\n')
          .filter((line) => !line.endsWith(' '))
      expect(lines(left).find((line) => line.startsWith('ca '))).toMatch(/^ca [0-9a-f]{64}$/)
      for (const line of lines(left)) {
        expect(lines(right)).not.toContain(line)
      }
      const [first, second] = launches.map((launch) => launch.vmEnv)
      expect(first?.ORCA_AGENT_HOOK_TOKEN).not.toBe(second?.ORCA_AGENT_HOOK_TOKEN)
      expect(first?.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^pod-sandbox-no-credential-/)
      expect(first?.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(second?.CLAUDE_CODE_OAUTH_TOKEN)
      console.info(`[clones] ${JSON.stringify({ left: lines(left), right: lines(right) })}`)
    } finally {
      relays.stopAll()
      hookServer.close()
      setPodSandboxAnthropicCredentials(null)
      await run('orb', ['delete', '--force', probe], { timeoutMs: 120_000 })
      for (const entry of registry.machines()) {
        await run('orb', ['delete', '--force', entry.name], { timeoutMs: 120_000 })
      }
      await templates.deleteAll()
      const left = (await run('orb', ['list', '--quiet'])).stdout.split('\n')
      rmSync(scratch, { recursive: true, force: true })
      expect(left.filter((name) => created.includes(name))).toEqual([])
    }
  }, 900_000)
})
