// Fork-only (Pod): the only way a network-isolated sandbox reaches the Mac. One `orb run` per running
// sandbox carries its connections over stdio; the Mac side dials nothing but the routes Pod listed.
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  RELAY_FRAME,
  RELAY_HEADER_BYTES,
  RELAY_STATE_DIR,
  SANDBOX_RELAY_AGENT_PY
} from './pod-orbstack-relay-agent'

/** A VM-side 127.0.0.1 port and the Mac 127.0.0.1 port it reaches. */
export type SandboxRelayRoute = { vmPort: number; hostPort: number }

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
  log?: (message: string) => void
}

export function encodeRelayFrame(kind: number, conn: number, payload?: Uint8Array): Buffer {
  const header = Buffer.alloc(RELAY_HEADER_BYTES)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(conn, 1)
  header.writeUInt32BE(payload?.byteLength ?? 0, 5)
  return payload ? Buffer.concat([header, payload]) : header
}

/** Splits a byte stream into frames; returns the leftover bytes of an incomplete one. */
export function decodeRelayFrames(
  buffered: Buffer,
  onFrame: (kind: number, conn: number, payload: Buffer) => void
): Buffer {
  let offset = 0
  while (buffered.length - offset >= RELAY_HEADER_BYTES) {
    const length = buffered.readUInt32BE(offset + 5)
    const end = offset + RELAY_HEADER_BYTES + length
    if (buffered.length < end) {
      break
    }
    onFrame(
      buffered.readUInt8(offset),
      buffered.readUInt32BE(offset + 1),
      buffered.subarray(offset + RELAY_HEADER_BYTES, end)
    )
    offset = end
  }
  return buffered.subarray(offset)
}

function sameRoutes(a: readonly SandboxRelayRoute[], b: readonly SandboxRelayRoute[]): boolean {
  return (
    a.length === b.length &&
    a.every((route, i) => route.vmPort === b[i]?.vmPort && route.hostPort === b[i]?.hostPort)
  )
}

type Relay = {
  child: ChildProcessWithoutNullStreams
  routes: readonly SandboxRelayRoute[]
  handle: SandboxRelayHandle
  exited: boolean
}

function startRelay(
  machine: string,
  routes: readonly SandboxRelayRoute[],
  deps: RelayDeps,
  onExit: () => void
): Relay {
  const nonce = randomBytes(12).toString('hex')
  const spec = JSON.stringify({
    nonce,
    stateDir: deps.stateDir ?? RELAY_STATE_DIR,
    routes: routes.map((route) => route.vmPort)
  })
  const child = deps.spawnAgent(machine, ['-I', '-c', SANDBOX_RELAY_AGENT_PY, spec])
  const sockets = new Map<number, Socket>()
  const paused = new Set<Socket>()
  child.stdin.on('drain', () => {
    for (const socket of paused) {
      socket.resume()
    }
    paused.clear()
  })
  const send = (kind: number, conn: number, payload?: Uint8Array): boolean =>
    !child.stdin.destroyed && child.stdin.write(encodeRelayFrame(kind, conn, payload))
  let markReady: (ready: boolean) => void = () => undefined
  const ready = new Promise<boolean>((resolve) => {
    markReady = resolve
  })

  const open = (conn: number, routeIndex: number): void => {
    const route = routes[routeIndex]
    if (!route) {
      // Only the listed Mac ports are ever dialed, whatever the VM asks for.
      send(RELAY_FRAME.close, conn)
      return
    }
    const socket = (deps.connectHost ?? ((port) => connect({ host: '127.0.0.1', port })))(
      route.hostPort
    )
    socket.setNoDelay(true)
    sockets.set(conn, socket)
    socket.on('data', (chunk: Buffer) => {
      if (!send(RELAY_FRAME.data, conn, chunk)) {
        socket.pause()
        paused.add(socket)
      }
    })
    socket.on('end', () => send(RELAY_FRAME.end, conn))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      paused.delete(socket)
      if (sockets.get(conn) === socket) {
        sockets.delete(conn)
        send(RELAY_FRAME.close, conn)
      }
    })
  }

  const onFrame = (kind: number, conn: number, payload: Buffer): void => {
    if (kind === RELAY_FRAME.ready) {
      markReady(true)
      return
    }
    if (kind === RELAY_FRAME.open) {
      open(conn, payload.readUInt8(0))
      return
    }
    const socket = sockets.get(conn)
    if (!socket) {
      return
    }
    if (kind === RELAY_FRAME.data) {
      if (!socket.write(payload)) {
        child.stdout.pause()
        socket.once('drain', () => child.stdout.resume())
      }
    } else if (kind === RELAY_FRAME.end) {
      socket.end()
    } else if (kind === RELAY_FRAME.close) {
      sockets.delete(conn)
      socket.destroy()
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
    for (const socket of sockets.values()) {
      socket.destroy()
    }
    sockets.clear()
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
      relay.child.stdin.end()
      relay.child.kill()
    }
  }

  /** Reuses the machine's live relay when its routes match; otherwise replaces it. */
  const ensure = (machine: string, routes: readonly SandboxRelayRoute[]): SandboxRelayHandle => {
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
