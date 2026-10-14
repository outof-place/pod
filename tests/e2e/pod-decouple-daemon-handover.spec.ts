// Fork-only (Pod): the update that brings pod-decouple adopts a daemon started before it, which
// reads ORCA_ env names, while the app now writes POD_ ones; old terminals keep ORCA_ env.
// TODO(pod): drop with the legacy-env overlap, after 2026-12-31.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { DaemonClient } from '../../src/main/daemon/client'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import type { CreateOrAttachResult, ListSessionsResult } from '../../src/main/daemon/types'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../../src/shared/agent-hook-listener/endpoint-publication'
import {
  createDaemonGenerationRuntime,
  type DaemonGenerationRuntime
} from './helpers/daemon-generation-runtime-fixture'
import {
  recordProcessTree,
  terminateRecordedTree,
  waitForCondition
} from './helpers/daemon-generation-processes'
import {
  buildPreDecoupleDaemonEntry,
  compileHookClient,
  current,
  launchFixtureDaemon,
  legacy,
  type FixtureDaemon
} from './helpers/pre-decouple-fixtures'

const PROTOCOL = 45
const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'

type Terminal = { adapter: DaemonPtyAdapter; id: string; output(): string }
type HookRequest = { url?: string; token?: string; body: string }

test.skip(
  process.platform !== 'darwin',
  'the native hook client and the zsh history repair are macOS-only'
)

/** Pod's data folder in the test shells' HOME: the only place an ORCA_ endpoint counts. */
function podDataFolder(runtime: DaemonGenerationRuntime): string {
  return path.join(runtime.rootDir, 'home', 'Library', 'Application Support', 'Pod')
}

function shellEnv(runtime: DaemonGenerationRuntime, names: Record<string, string>) {
  const home = path.join(runtime.rootDir, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(path.join(runtime.rootDir, 'history'), { recursive: true })
  // Why: an empty .zshrc keeps zsh's new-user menu out of the unwrapped control shell.
  writeFileSync(path.join(home, '.zshrc'), '')
  return { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ...names }
}

async function spawnShell(daemon: FixtureDaemon, env: Record<string, string>, cwd: string) {
  const adapter = new DaemonPtyAdapter({
    socketPath: daemon.socketPath,
    tokenPath: daemon.tokenPath
  })
  let output = ''
  const { id } = await adapter.spawn({ cols: 120, rows: 30, cwd, env, shellOverride: '/bin/zsh' })
  adapter.onData((event) => {
    if (event.id === id) {
      output = `${output}${event.data}`.slice(-65_536)
    }
  })
  return { adapter, id, output: () => output } satisfies Terminal
}

/** Prints `<tag>:<value>:END` from the shell; the typed line itself only echoes `${...}`. */
async function shellValue(terminal: Terminal, tag: string, expression: string): Promise<string> {
  terminal.adapter.write(terminal.id, `print -r -- "${tag}:${expression}:END"\r`)
  const pattern = new RegExp(`${tag}:([^$:\\r\\n]*):END`)
  await waitForCondition(`${tag} from the shell`, () => pattern.test(terminal.output()), 20_000)
  return pattern.exec(terminal.output())?.[1] ?? ''
}

async function terminalHandles(daemon: FixtureDaemon): Promise<Map<string, string | undefined>> {
  const client = new DaemonClient({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
  try {
    await client.ensureConnected()
    const { sessions } = await client.request<ListSessionsResult>('listSessions', undefined)
    return new Map(sessions.map((session) => [session.sessionId, session.terminalHandle]))
  } finally {
    client.disconnect()
  }
}

async function startHookServer(requests: HookRequest[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({
        url: req.url,
        token: req.headers['x-orca-agent-hook-token']?.toString(),
        body
      })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 }
}

test.describe('an update that adopts a daemon from before the decouple', () => {
  let runtime: DaemonGenerationRuntime
  const daemons: FixtureDaemon[] = []
  const terminals: Terminal[] = []

  test.beforeEach(
    async (
      // oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
      {},
      testInfo: TestInfo
    ) => {
      runtime = await createDaemonGenerationRuntime(testInfo)
    }
  )

  test.afterEach(async () => {
    for (const terminal of terminals.splice(0)) {
      terminal.adapter.dispose()
    }
    const trees = await Promise.all(
      daemons.splice(0).map((daemon) => recordProcessTree(daemon.identity))
    )
    await terminateRecordedTree(trees.flat())
    runtime.remove()
  })

  test('a new terminal on the adopted daemon has its handle and history file', async () => {
    test.setTimeout(120_000)
    const old = await launchFixtureDaemon({
      runtime,
      entryPath: await buildPreDecoupleDaemonEntry(runtime),
      label: 'pre-decouple',
      protocolVersion: PROTOCOL
    })
    daemons.push(old)
    const histFile = path.join(runtime.rootDir, 'history', 'zsh_history')
    const env = shellEnv(runtime, {
      HISTFILE: histFile,
      [current('HISTFILE')]: histFile,
      [current('TERMINAL_HANDLE')]: 'term-after-update'
    })

    // Control: the request a decoupled app without the overlap sends is lost on this daemon.
    const client = new DaemonClient({ socketPath: old.socketPath, tokenPath: old.tokenPath })
    await client.ensureConnected()
    const bare = await client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: 'pod-only-request',
      cols: 80,
      rows: 24,
      cwd: runtime.rootDir,
      env,
      shellOverride: '/bin/zsh'
    })
    client.disconnect()
    expect(bare.isNew).toBe(true)
    expect((await terminalHandles(old)).get('pod-only-request')).toBeUndefined()

    const terminal = await spawnShell(old, env, runtime.rootDir)
    terminals.push(terminal)
    expect((await terminalHandles(old)).get(terminal.id)).toBe('term-after-update')
    // The history feature: the wrapper puts back the HISTFILE macOS /etc/zshrc overwrote.
    expect(await shellValue(terminal, 'HF', '${HISTFILE}')).toBe(histFile)
  })

  test('a new daemon gets the POD_ names only', async () => {
    test.setTimeout(120_000)
    const fresh = await launchFixtureDaemon({
      runtime,
      entryPath: runtime.entryPath,
      label: 'decoupled',
      protocolVersion: PROTOCOL
    })
    daemons.push(fresh)
    const histFile = path.join(runtime.rootDir, 'history', 'zsh_history')
    const terminal = await spawnShell(
      fresh,
      shellEnv(runtime, {
        HISTFILE: histFile,
        [current('HISTFILE')]: histFile,
        [current('TERMINAL_HANDLE')]: 'term-fresh'
      }),
      runtime.rootDir
    )
    terminals.push(terminal)
    expect((await terminalHandles(fresh)).get(terminal.id)).toBe('term-fresh')
    expect(await shellValue(terminal, 'HF', '${HISTFILE}')).toBe(histFile)
    expect(await shellValue(terminal, 'TW', `\${${legacy('TERMINAL_HANDLE')}-none}`)).toBe('none')
  })

  test('a runtime from before the decouple (a rollback) on a decoupled daemon', async () => {
    test.setTimeout(120_000)
    const fresh = await launchFixtureDaemon({
      runtime,
      entryPath: runtime.entryPath,
      label: 'decoupled',
      protocolVersion: PROTOCOL
    })
    daemons.push(fresh)
    const histFile = path.join(runtime.rootDir, 'history', 'zsh_history')
    // What the app before the update sends: its ORCA_ names only.
    const terminal = await spawnShell(
      fresh,
      shellEnv(runtime, {
        HISTFILE: histFile,
        [legacy('HISTFILE')]: histFile,
        [legacy('TERMINAL_HANDLE')]: 'term-before-update'
      }),
      runtime.rootDir
    )
    terminals.push(terminal)
    expect((await terminalHandles(fresh)).get(terminal.id)).toBe('term-before-update')
    expect(await shellValue(terminal, 'HF', '${HISTFILE}')).toBe(histFile)
    // That app's own hook scripts still read the ORCA_ spelling.
    expect(await shellValue(terminal, 'TL', `\${${legacy('TERMINAL_HANDLE')}-none}`)).toBe(
      'term-before-update'
    )
  })

  test("a daemon started from a live Pod's pane keeps that pane's ORCA_ env out", async () => {
    test.setTimeout(120_000)
    const requests: HookRequest[] = []
    const { server, port } = await startHookServer(requests)
    try {
      // The live Pod's hook server, published as that Pod publishes it.
      const liveDir = path.join(podDataFolder(runtime), 'agent-hooks')
      mkdirSync(liveDir, { recursive: true })
      const liveEndpoint = path.join(liveDir, getEndpointFileName())
      expect(
        writeEndpointFile(liveDir, liveEndpoint, {
          port,
          token: 'live-pod-token',
          env: 'production',
          version: '1'
        })
      ).toBe(true)
      const inherited = ['AGENT_HOOK_ENDPOINT', 'PANE_KEY', 'AGENT_LAUNCH_TOKEN']
      const fresh = await launchFixtureDaemon({
        runtime,
        entryPath: runtime.entryPath,
        label: 'decoupled',
        protocolVersion: PROTOCOL,
        inheritedEnv: {
          [legacy('AGENT_HOOK_ENDPOINT')]: liveEndpoint,
          [legacy('PANE_KEY')]: 'tab-9:live-pane',
          [legacy('AGENT_LAUNCH_TOKEN')]: 'live-launch'
        }
      })
      daemons.push(fresh)
      // A dev receiver without an endpoint file names none.
      const terminal = await spawnShell(
        fresh,
        shellEnv(runtime, {
          [current('AGENT_HOOK_ENV')]: 'development',
          [current('AGENT_HOOK_VERSION')]: '1',
          [current('PANE_KEY')]: PANE,
          [current('TAB_ID')]: 'tab-1'
        }),
        runtime.rootDir
      )
      terminals.push(terminal)
      for (const [index, name] of inherited.entries()) {
        expect(await shellValue(terminal, `IN${index}`, `\${${legacy(name)}-none}`)).toBe('none')
      }
      const client = await compileHookClient(
        path.join(runtime.rootDir, 'pod-agent-hook'),
        'current',
        podDataFolder(runtime)
      )
      terminal.adapter.write(
        terminal.id,
        `printf '%s' '{"hook_event_name":"Stop"}' | '${client}'\r`
      )
      // The client answers synchronously, so once the shell runs the next line it is done.
      await shellValue(terminal, 'SENT', '${?}')
      expect(requests).toEqual([])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('claude in a terminal from before the update still reports its status', async () => {
    test.setTimeout(120_000)
    const old = await launchFixtureDaemon({
      runtime,
      entryPath: await buildPreDecoupleDaemonEntry(runtime),
      label: 'pre-decouple',
      protocolVersion: PROTOCOL
    })
    daemons.push(old)
    const requests: HookRequest[] = []
    const { server, port } = await startHookServer(requests)
    try {
      // Pod's own data folder: the client takes an ORCA_ endpoint only from there.
      const endpointDir = path.join(podDataFolder(runtime), 'agent-hooks')
      const endpoint = path.join(endpointDir, getEndpointFileName())
      // What the app before the update gave the pane: ORCA_ names, its own server's coordinates.
      const terminal = await spawnShell(
        old,
        shellEnv(runtime, {
          [legacy('PANE_KEY')]: PANE,
          [legacy('TAB_ID')]: 'tab-1',
          [legacy('WORKTREE_ID')]: 'repo::/w',
          [legacy('AGENT_HOOK_ENV')]: 'production',
          [legacy('AGENT_HOOK_VERSION')]: '1',
          [legacy('AGENT_HOOK_PORT')]: '9',
          [legacy('AGENT_HOOK_TOKEN')]: 'token-before-update',
          [legacy('AGENT_HOOK_ENDPOINT')]: endpoint
        }),
        runtime.rootDir
      )
      terminals.push(terminal)
      // The updated app publishes its hook server through the same endpoint file.
      mkdirSync(endpointDir, { recursive: true })
      expect(
        writeEndpointFile(endpointDir, endpoint, {
          port,
          token: 'token-after-update',
          env: 'production',
          version: '1'
        })
      ).toBe(true)

      // A claude started now runs the new client; one running since before, the old client.
      const clients = {
        current: await compileHookClient(
          path.join(runtime.rootDir, 'pod-agent-hook'),
          'current',
          podDataFolder(runtime)
        ),
        old: await compileHookClient(
          path.join(runtime.rootDir, 'pod-agent-hook-old'),
          'pre-decouple'
        )
      }
      for (const [era, client] of Object.entries(clients)) {
        terminal.adapter.write(
          terminal.id,
          `printf '%s' '{"hook_event_name":"Stop"}' | '${client}'; print -r -- "${era}:sent:END"\r`
        )
        await waitForCondition(`the ${era} client`, () => requests.length > 0, 20_000)
        const [request, ...more] = requests.splice(0)
        expect(more).toEqual([])
        expect(request).toMatchObject({ url: '/hook/claude', token: 'token-after-update' })
        expect(new URLSearchParams(request?.body).get('paneKey')).toBe(PANE)
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
