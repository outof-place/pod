// Fork-only (Pod): times real OrbStack machine creation and agent start, for the numbers in
// README.md. Opt-in: POD_E2E_ORBSTACK_TIMING=1 (downloads a Claude Code release once). Creates and
// deletes only machines it names itself; `orb list` holds none of them afterwards.
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { POD_ORBSTACK_BUILTIN_RECIPE, podOrbstackMachineName } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createSandboxRelays } from './pod-orbstack-relay'
import { createPodOrbstackTemplates } from './pod-orbstack-templates'
import { buildSandboxAgentCommand } from './pod-orbstack-terminal-override'
import {
  createOrbstackToolRunner,
  resolveOrbstackToolPaths,
  type OrbstackToolRunner
} from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK_TIMING === '1'
const RUNS = Number(process.env.POD_E2E_ORBSTACK_TIMING_RUNS ?? 3)
const OUT = process.env.POD_E2E_ORBSTACK_TIMING_OUT
// Why a switch: the same runs measure the old path (off) and the template path (on).
const TEMPLATES = process.env.POD_E2E_ORBSTACK_TIMING_TEMPLATES === '1'

/** Runs a command in a pty and reports when its output first matches `pattern`. */
const PTY_PROBE = String.raw`
import json, os, pty, re, select, signal, struct, sys, time, fcntl, termios
pattern = re.compile(sys.argv[1].encode(), re.I); limit = float(sys.argv[2]); cmd = sys.argv[3:]
ANSWERS = [(b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'), (b'\x1b]10;?', b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
           (b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?62;22c'), (b'\x1b[?u', b'\x1b[?0u')]
start = time.monotonic(); pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
buf = b''; first = None; matched = None
while time.monotonic() - start < limit:
    ready, _, _ = select.select([fd], [], [], 0.02)
    if not ready:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    first = first if first is not None else time.monotonic() - start
    buf += data
    # Answer what a terminal answers: orb waits 5 s for OSC 11 and DSR replies otherwise.
    for query, reply in ANSWERS:
        if query in data:
            os.write(fd, reply)
    if pattern.search(buf):
        matched = time.monotonic() - start
        break
try:
    os.kill(pid, signal.SIGHUP); time.sleep(0.2); os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
print(json.dumps({'firstMs': first and first * 1000, 'matchMs': matched and matched * 1000}))
`

async function ptyProbe(pattern: string, command: string[], limitS = 60) {
  const result = await runProcess({
    program: 'python3',
    args: ['-I', '-c', PTY_PROBE, pattern, String(limitS), ...command],
    timeoutMs: (limitS + 10) * 1000
  })
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
    firstMs: number | null
    matchMs: number | null
  }
}

function timedRunner(run: OrbstackToolRunner, steps: { step: string; ms: number }[]) {
  const timed: OrbstackToolRunner = async (tool, args, options) => {
    const start = performance.now()
    const result = await run(tool, args, options)
    const words = args.filter((arg) => !arg.startsWith('-')).slice(0, 4)
    steps.push({ step: `${tool} ${words.join(' ').slice(0, 60)}`, ms: performance.now() - start })
    return result
  }
  return timed
}

function record(row: Record<string, unknown>): void {
  const line = JSON.stringify({ ...row, load1: Number(loadavg()[0].toFixed(1)) })
  console.info(`[timing] ${line}`)
  if (OUT) {
    appendFileSync(OUT, `${line}\n`)
  }
}

describe.skipIf(!enabled)('OrbStack timing', () => {
  it('measures sandbox and shared machine creation and agent start', async () => {
    const paths = () => resolveOrbstackToolPaths()
    const orb = paths().orb ?? 'orb'
    const realRun = createOrbstackToolRunner(paths)
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pod-test-timing-')))
    const registry = new PodOrbstackRegistry(join(scratch, 'registry.json'))
    const cache = createClaudeReleaseCache({
      root: join(scratch, 'releases'),
      fetcher: (url, init) => fetch(url, init),
      platform: () => sandboxClaudePlatform()
    })
    const hostVersion = process.env.POD_E2E_ORBSTACK_TIMING_CLAUDE ?? null
    let steps: { step: string; ms: number }[] = []
    const run = timedRunner(realRun, steps)
    const templates = TEMPLATES
      ? createPodOrbstackTemplates({
          run: (tool, args, options) => run(tool, args, options),
          file: join(scratch, 'templates.json')
        })
      : undefined
    const machines = createPodOrbstackMachines({
      paths,
      run: (tool, args, options) => run(tool, args, options),
      registry,
      loadRecipe: () => POD_ORBSTACK_BUILTIN_RECIPE,
      prepareClaudeRelease: () => cache.prepare(hostVersion),
      ...(templates ? { templates } : {})
    })
    const hookServer = createServer((socket) =>
      socket.end('HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok')
    )
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve))
    const address: AddressInfo | string | null = hookServer.address()
    const hookPort = typeof address === 'object' && address ? address.port : 0
    const relays = createSandboxRelays({
      spawnAgent: (machine, args) =>
        spawnProcess({ program: orb, args: ['-m', machine, '-u', 'root', 'python3', ...args] })
    })
    const route = { vmPort: hookPort, hostPort: hookPort, hookToken: 't', authorize: () => true }
    const worktrees: string[] = []
    const names: string[] = []
    const worktree = (label: string): string => {
      const dir = realpathSync(mkdtempSync(join(scratch, `${label}-`)))
      worktrees.push(dir)
      return dir
    }
    try {
      const prepareStart = performance.now()
      const release = await cache.prepare(hostVersion)
      record({
        phase: 'release-download',
        ms: performance.now() - prepareStart,
        version: release.version
      })
      for (let index = 0; index < RUNS; index += 1) {
        const path = worktree(`sbx${index}`)
        const worktreeId = `timing-sbx-${index}::${path}`
        steps.length = 0
        const start = performance.now()
        const created = await machines.createSandbox({
          worktreeId,
          worktreePath: path,
          displayName: 'timing'
        })
        const createMs = performance.now() - start
        expect(created).toEqual({ ok: true })
        record({
          phase: 'sandbox-create',
          run: index,
          templates: TEMPLATES,
          ms: createMs,
          steps: [...steps]
        })
        const name = podOrbstackMachineName(worktreeId, path, 'sandbox')
        names.push(name)
        const launch = (nonce: string | null, command = 'claude') =>
          buildSandboxAgentCommand({
            orbPath: orb,
            machine: name,
            cwd: path,
            command,
            forwardEnv: ['COLORTERM'],
            relayNonce: nonce
          })
        // Cold launch: the relay starts with the agent, as the first launch after Pod starts.
        const relayStart = performance.now()
        const handle = relays.ensure(name, { hook: route, anthropic: null })
        const coldProbe = ptyProbe('claude code|welcome|theme|log ?in|trust', [
          'sh',
          '-c',
          launch(handle.nonce)
        ])
        const ready = await handle.ready
        const relayReadyMs = performance.now() - relayStart
        const cold = await coldProbe
        // Warm launch: the relay is already up (the second launch, or a pre-warmed relay).
        const warm = await ptyProbe('claude code|welcome|theme|log ?in|trust', [
          'sh',
          '-c',
          launch(handle.nonce)
        ])
        const version = await ptyProbe('\\d+\\.\\d+\\.\\d+', [
          'sh',
          '-c',
          launch(handle.nonce, 'claude --version')
        ])
        record({ phase: 'agent-start', run: index, ready, relayReadyMs, cold, warm, version })
        relays.stop(name)
        expect(await machines.remove(worktreeId, 'sandbox')).toEqual({ ok: true })
      }
      for (let index = 0; index < RUNS; index += 1) {
        const path = worktree(`shared${index}`)
        const worktreeId = `timing-shared-${index}::${path}`
        steps.length = 0
        const start = performance.now()
        const created = await machines.create({
          worktreeId,
          worktreePath: path,
          displayName: 'timing'
        })
        const createMs = performance.now() - start
        expect(created).toEqual({ ok: true })
        const name = podOrbstackMachineName(worktreeId, path)
        names.push(name)
        const prompt = await ptyProbe('[$#] $', [orb, '-m', name])
        record({
          phase: 'shared-create',
          run: index,
          templates: TEMPLATES,
          ms: createMs,
          prompt,
          steps: [...steps]
        })
        expect(await machines.remove(worktreeId)).toEqual({ ok: true })
      }
    } finally {
      relays.stopAll()
      hookServer.close()
      for (const entry of registry.machines()) {
        await realRun('orb', ['delete', '--force', entry.name], { timeoutMs: 120_000 })
      }
      await templates?.deleteAll()
      steps = []
      const left = (await realRun('orb', ['list', '--quiet'])).stdout.split('\n')
      rmSync(scratch, { recursive: true, force: true })
      expect(left.filter((name) => names.includes(name) || name.startsWith('pod-tmpl-'))).toEqual(
        []
      )
    }
  }, 1_800_000)
})
