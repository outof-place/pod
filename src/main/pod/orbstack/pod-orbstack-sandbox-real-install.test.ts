// Fork-only (Pod): downloads a real Claude Code release and installs it in a real OrbStack sandbox.
// Opt-in: POD_E2E_ORBSTACK=1. Creates and deletes one pod-*-sbx machine; touches no other machine.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createSecureServer } from 'node:http2'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import { createClaudeOAuthSandboxCredentials } from './pod-orbstack-anthropic-oauth'
import {
  createAnthropicRoute,
  type SandboxAnthropicCredentials
} from './pod-orbstack-anthropic-route'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { createSandboxRelays } from './pod-orbstack-relay'
import { podOrbstackMachineName } from './pod-orbstack-recipe'
import { SANDBOX_CA_PATH } from './pod-orbstack-relay-agent'
import { provisionSandbox } from './pod-orbstack-sandbox'
import { SANDBOX_CREDENTIAL_PLACEHOLDER } from './pod-orbstack-sandbox-access'
import { createSandboxCa } from './pod-orbstack-sandbox-ca'
import { createOrbstackToolRunner, resolveOrbstackToolPaths } from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK === '1'

async function orbProcesses(machine: string, pattern = `-m ${machine}`): Promise<string[]> {
  const result = await runProcess({ program: 'pgrep', args: ['-fl', '--', pattern] })
  return result.stdout.split('\n').filter((line) => line.includes('orb'))
}

const relayProcesses = (machine: string) => orbProcesses(machine, `-m ${machine} -u root python3`)

async function listen(server: Pick<Server, 'listen' | 'address'>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

const STUB_TEXT = 'Hello from the Pod stub API'
const FAKE_OAUTH_TOKEN = 'pod-e2e-fake-oauth-token'

/** A stand-in for api.anthropic.com with its own CA: no real API, no real credential. */
async function stubAnthropicApi() {
  const ca = createSandboxCa('stub-upstream')
  const seen: { method?: string; path?: string; apiKey?: string; authorization?: string }[] = []
  const message = {
    id: 'msg_pod_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-stub',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 6 }
  }
  const server = createSecureServer(
    { allowHTTP1: true, key: ca.leafKeyPem, cert: ca.leafCertPem },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          method: req.method,
          path: req.url,
          apiKey: req.headers['x-api-key']?.toString(),
          authorization: req.headers.authorization
        })
        const raw = Buffer.concat(chunks)
        const text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
        const body = text.length ? JSON.parse(text.toString()) : {}
        if (req.url?.startsWith('/v1/messages/count_tokens')) {
          res.end(JSON.stringify({ input_tokens: 1 }))
        } else if (req.url?.startsWith('/v1/messages') && body.stream) {
          const event = (type: string, data: object) =>
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          event('message_start', { message: { ...message, content: [], stop_reason: null } })
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: STUB_TEXT } })
          event('content_block_stop', { index: 0 })
          event('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 6 }
          })
          event('message_stop', {})
          res.end()
        } else if (req.url?.startsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              ...message,
              content: [{ type: 'text', text: STUB_TEXT }],
              stop_reason: 'end_turn'
            })
          )
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [], has_more: false }))
        }
      })
    }
  )
  const port = await listen(server)
  return { ca, seen, port, close: () => server.close() }
}

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
        expect(await relays.ensure(name, { hook: route, anthropic: null }).ready).toBe(true)
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

        // anthropic-api route: real Claude Code in the VM against a stub API on the Mac.
        const api = await stubAnthropicApi()
        const refused: string[] = []
        // The OAuth leg below swaps the source on this same route, relay and CA.
        let credentials: SandboxAnthropicCredentials = {
          mode: () => 'api-key',
          authHeaders: async () => ({ 'x-api-key': 'pod-e2e-stub-key' })
        }
        const anthropic = createAnthropicRoute({
          machine: name,
          ca: createSandboxCa(name),
          credentials: () => credentials,
          upstream: { host: '127.0.0.1', port: api.port, ca: api.ca.caCertPem },
          log: (line) => refused.push(line)
        })
        try {
          expect(
            await relays.ensure(name, { hook: route, anthropic: { route: anthropic } }).ready
          ).toBe(true)
          const pinned = await run('orb', [
            'run',
            '-m',
            name,
            'getent',
            'ahosts',
            'api.anthropic.com'
          ])
          const addresses = new Set(
            pinned.stdout
              .split('\n')
              .map((line) => line.split(/\s+/)[0])
              .filter(Boolean)
          )
          expect([...addresses].sort()).toEqual(['127.0.0.1', '::1'])
          const claude = (
            extraEnv: string,
            credentialEnv = `ANTHROPIC_API_KEY=${SANDBOX_CREDENTIAL_PLACEHOLDER}`
          ) =>
            run(
              'orb',
              [
                'run',
                '-m',
                name,
                'bash',
                '-c',
                `cd "$0" && ${extraEnv} ${credentialEnv} DISABLE_AUTOUPDATER=1 timeout 40 "$HOME/.local/bin/claude" -p 'say hi' 2>&1`,
                worktree
              ],
              { timeoutMs: 90_000 }
            )
          // Without the sandbox CA, Claude Code must refuse the Mac's certificate.
          const untrusted = await claude('')
          expect(untrusted.code).not.toBe(0)
          expect(api.seen).toEqual([])
          const trusted = await claude(`NODE_EXTRA_CA_CERTS=${SANDBOX_CA_PATH}`)
          expect({ code: trusted.code, out: trusted.stdout.slice(-400), refused }).toMatchObject({
            code: 0
          })
          expect(trusted.stdout).toContain(STUB_TEXT)
          const messages = api.seen.filter((request) => request.path?.startsWith('/v1/messages'))
          expect(messages.length).toBeGreaterThan(0)
          for (const request of api.seen) {
            expect(request.authorization).toBeUndefined()
            if (request.apiKey !== undefined) {
              expect(request.apiKey).toBe('pod-e2e-stub-key')
            }
          }
          console.info(
            `anthropic-api route: ${api.seen.map((r) => `${r.method} ${r.path?.split('?')[0]}`).join(', ')}; refused: ${refused.join(', ') || 'none'}`
          )

          // OAuth, as Pod ships it: the real source over a fake login, Claude Code on the OAuth placeholder.
          const oauth = createClaudeOAuthSandboxCredentials({
            target: () => ({ account: 'system', configDir: null }),
            read: async () =>
              JSON.stringify({
                claudeAiOauth: { accessToken: FAKE_OAUTH_TOKEN, expiresAt: Date.now() + 3_600_000 }
              })
          })
          oauth.launched({ machine: name })
          credentials = oauth
          api.seen.length = 0
          refused.length = 0
          try {
            const viaOauth = await claude(
              `NODE_EXTRA_CA_CERTS=${SANDBOX_CA_PATH}`,
              `CLAUDE_CODE_OAUTH_TOKEN=${SANDBOX_CREDENTIAL_PLACEHOLDER}`
            )
            expect({
              code: viaOauth.code,
              out: viaOauth.stdout.slice(-400),
              refused
            }).toMatchObject({ code: 0 })
            expect(viaOauth.stdout).toContain(STUB_TEXT)
            expect(api.seen.some((r) => r.path?.startsWith('/v1/messages'))).toBe(true)
            for (const request of api.seen) {
              expect(request.apiKey).toBeUndefined()
              if (request.authorization !== undefined) {
                expect(request.authorization).toBe(`Bearer ${FAKE_OAUTH_TOKEN}`)
              }
            }
            console.info(
              `anthropic-api route (oauth): ${api.seen.map((r) => `${r.method} ${r.path?.split('?')[0]}`).join(', ')}; refused: ${refused.join(', ') || 'none'}`
            )
          } finally {
            oauth.released({ machine: name })
          }
        } finally {
          anthropic.close()
          api.close()
        }
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
