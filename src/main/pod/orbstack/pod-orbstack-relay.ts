// Fork-only (Pod): the only way a network-isolated sandbox reaches the Mac. One `orb run` per running
// sandbox carries its connections over stdio. It is no tunnel. Two route kinds exist:
// - `hook`: Claude hook posts to Pod's hook server, one per connection, checked here;
// - `anthropic-api` (only while a credential source is on): the VM's api.anthropic.com, served by
//   the sandbox's own TLS endpoint in this process.
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AnthropicRoute } from './pod-orbstack-anthropic-route'
import {
  decodeRelayFrames,
  encodeRelayFrame,
  hookConnection,
  streamConnection,
  type Send,
  type SandboxHookRoute
} from './pod-orbstack-relay-connections'
import {
  RELAY_FRAME,
  RELAY_STATE_DIR,
  SANDBOX_CA_PATH,
  SANDBOX_RELAY_AGENT_PY
} from './pod-orbstack-relay-agent'
import { ANTHROPIC_API_HOST } from './pod-orbstack-sandbox-ca'

const STOP_GRACE_MS = 3_000

/** The VM's api.anthropic.com: pinned to its 127.0.0.1 and served by `route` on the Mac. */
export type SandboxAnthropicRelayRoute = {
  route: Pick<AnthropicRoute, 'attach' | 'caCertPem'>
  /** 443 in a sandbox; tests use a free port. */
  vmPort?: number
}

export type SandboxRelayRoutes = {
  hook: SandboxHookRoute
  anthropic: SandboxAnthropicRelayRoute | null
}

export type SandboxRelayHandle = {
  /** Written to `<RELAY_STATE_DIR>/ready` once the VM side listens; a launch waits for it. */
  nonce: string
  ready: Promise<boolean>
}

type RelayDeps = {
  /** Starts the VM half: `orb -m <machine> -u root python3 -I -c <agent> <spec>`. */
  spawnAgent: (machine: string, args: readonly string[]) => ChildProcessWithoutNullStreams
  connectHost?: (port: number) => Socket
  stateDir?: string
  /** The VM's hosts file and CA path; tests point them at a temp dir. */
  hostsFile?: string
  caPath?: string
  log?: (message: string) => void
}

function sameRoutes(a: SandboxRelayRoutes, b: SandboxRelayRoutes): boolean {
  return (
    a.hook.vmPort === b.hook.vmPort &&
    a.hook.hostPort === b.hook.hostPort &&
    a.hook.hookToken === b.hook.hookToken &&
    a.anthropic?.route.caCertPem === b.anthropic?.route.caCertPem &&
    a.anthropic?.vmPort === b.anthropic?.vmPort
  )
}

type Relay = {
  child: ChildProcessWithoutNullStreams
  routes: SandboxRelayRoutes
  handle: SandboxRelayHandle
  exited: boolean
}

function startRelay(
  machine: string,
  routes: SandboxRelayRoutes,
  deps: RelayDeps,
  onExit: () => void
): Relay {
  const nonce = randomBytes(12).toString('hex')
  const { hook: route, anthropic } = routes
  const caPath = deps.caPath ?? SANDBOX_CA_PATH
  const spec = JSON.stringify({
    nonce,
    stateDir: deps.stateDir ?? RELAY_STATE_DIR,
    routes: [route.vmPort, ...(anthropic ? [anthropic.vmPort ?? 443] : [])],
    // The pin names ::1 too, so the API route listens on both loopbacks.
    ipv6Routes: anthropic ? [1] : [],
    // Rewritten on every start, so a relay without the route also removes an older pin and CA.
    hosts: { file: deps.hostsFile ?? '/etc/hosts', names: anthropic ? [ANTHROPIC_API_HOST] : [] },
    files: { [caPath]: anthropic ? anthropic.route.caCertPem : null }
  })
  const child = deps.spawnAgent(machine, ['-I', '-c', SANDBOX_RELAY_AGENT_PY, spec])
  const conns = new Map<number, { data(chunk: Buffer): void; end(): void; close(): void }>()
  const send: Send = (kind, conn, payload) =>
    !child.stdin.destroyed && child.stdin.write(encodeRelayFrame(kind, conn, payload))
  const drainWaiters: (() => void)[] = []
  child.stdin.on('drain', () => {
    for (const resume of drainWaiters.splice(0)) {
      resume()
    }
  })
  const dial = deps.connectHost ?? ((port: number) => connect({ host: '127.0.0.1', port }))
  let markReady: (ready: boolean) => void = () => undefined
  const ready = new Promise<boolean>((resolve) => {
    markReady = resolve
  })

  const onFrame = (kind: number, conn: number, payload: Buffer): void => {
    if (kind === RELAY_FRAME.ready) {
      markReady(true)
      return
    }
    if (kind === RELAY_FRAME.open) {
      const index = payload.readUInt8(0)
      if (index === 0) {
        conns.set(
          conn,
          hookConnection(conn, route, send, dial, () => conns.delete(conn))
        )
      } else if (index === 1 && anthropic) {
        const connection = streamConnection(conn, send, (resume) => drainWaiters.push(resume))
        connection.stream.on('close', () => conns.delete(conn))
        conns.set(conn, connection)
        anthropic.route.attach(connection.stream)
      } else {
        send(RELAY_FRAME.close, conn)
      }
      return
    }
    const connection = conns.get(conn)
    if (kind === RELAY_FRAME.data) {
      connection?.data(payload)
    } else if (kind === RELAY_FRAME.end) {
      connection?.end()
    } else if (kind === RELAY_FRAME.close) {
      connection?.close()
    }
  }

  let pending: Buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    pending = decodeRelayFrames(pending.length ? Buffer.concat([pending, chunk]) : chunk, onFrame)
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000)
  })
  child.stdin.on('error', () => undefined)
  const relay: Relay = { child, routes, handle: { nonce, ready }, exited: false }
  child.on('exit', (code, signal) => {
    relay.exited = true
    markReady(false)
    for (const connection of conns.values()) {
      connection.close()
    }
    const detail = stderr.trim().split('\n').slice(-3).join(' | ')
    deps.log?.(`relay for ${machine} exited (${code ?? signal})${detail ? `: ${detail}` : ''}`)
    onExit()
  })
  child.on('error', (error) => deps.log?.(`relay for ${machine} failed: ${error.message}`))
  return relay
}

export function createSandboxRelays(deps: RelayDeps) {
  const relays = new Map<string, Relay>()

  const stop = (machine: string): void => {
    const relay = relays.get(machine)
    relays.delete(machine)
    if (relay && !relay.exited) {
      // EOF first: the VM side then removes its hosts pin and CA file before it exits.
      relay.child.stdin.end()
      setTimeout(() => {
        if (!relay.exited) {
          relay.child.kill()
        }
      }, STOP_GRACE_MS).unref()
    }
  }

  /** Reuses the machine's live relay when its routes match; otherwise replaces it. */
  const ensure = (machine: string, routes: SandboxRelayRoutes): SandboxRelayHandle => {
    const current = relays.get(machine)
    if (current && !current.exited && sameRoutes(current.routes, routes)) {
      return current.handle
    }
    stop(machine)
    const relay = startRelay(machine, routes, deps, () => {
      if (relays.get(machine) === relay) {
        relays.delete(machine)
      }
    })
    relays.set(machine, relay)
    return relay.handle
  }

  return {
    ensure,
    stop,
    stopAll: (): void => [...relays.keys()].forEach(stop)
  }
}

export type SandboxRelays = ReturnType<typeof createSandboxRelays>

/** Shell prefix for the in-VM launch: wait up to 15 s for this relay, then start regardless. */
export function buildRelayWait(nonce: string, stateDir: string = RELAY_STATE_DIR): string {
  return `w=0; until [ "$(cat ${stateDir}/ready 2>/dev/null)" = ${nonce} ] || [ $w -ge 150 ]; do sleep 0.1; w=$((w+1)); done;`
}

export { decodeRelayFrames, encodeRelayFrame, type SandboxHookRoute }
