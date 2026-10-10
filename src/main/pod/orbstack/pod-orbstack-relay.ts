// Fork-only (Pod): the only way a network-isolated sandbox reaches the Mac. One `orb run` per running
// sandbox carries its connections over stdio. It is no tunnel: the Mac side forwards Claude hook
// posts to Pod's hook server, one per connection, and answers everything else itself.
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { HOOK_CONTINUE, hookRejection, readHookRequest } from './pod-orbstack-hook-filter'
import {
  RELAY_FRAME,
  RELAY_HEADER_BYTES,
  RELAY_STATE_DIR,
  SANDBOX_RELAY_AGENT_PY
} from './pod-orbstack-relay-agent'

/** Claude hook posts from the VM to Pod's hook server. */
export type SandboxHookRoute = {
  /** Port the hook script posts to inside the VM: the hook server's own, so the script is unchanged. */
  vmPort: number
  hostPort: number
  /** The hook server's token. It never enters the VM. */
  hookToken: string
  /** Checks the sandbox's own token, which the VM sends in its place. */
  authorize: (token: string) => boolean
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

type Send = (kind: number, conn: number, payload?: Uint8Array) => boolean

/** One VM connection: buffer one hook post, check it, then forward it or answer it here. */
function hookConnection(
  conn: number,
  route: SandboxHookRoute,
  send: Send,
  dial: (port: number) => Socket,
  done: () => void
) {
  let buffered = Buffer.alloc(0)
  let continued = false
  let state: 'reading' | 'forwarded' | 'rejected' = 'reading'
  let upstream: Socket | null = null
  const reject = (status: number): void => {
    state = 'rejected'
    buffered = Buffer.alloc(0)
    send(RELAY_FRAME.data, conn, hookRejection(status))
    send(RELAY_FRAME.end, conn)
  }
  return {
    data(chunk: Buffer): void {
      if (state !== 'reading') {
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const verdict = readHookRequest(buffered, route)
      if (verdict.kind === 'reject') {
        reject(verdict.status)
      } else if (verdict.kind === 'incomplete') {
        if (verdict.expectContinue && !continued) {
          continued = true
          send(RELAY_FRAME.data, conn, HOOK_CONTINUE)
        }
      } else {
        state = 'forwarded'
        buffered = Buffer.alloc(0)
        const socket = dial(route.hostPort)
        upstream = socket
        socket.on('data', (reply: Buffer) => send(RELAY_FRAME.data, conn, reply))
        socket.on('end', () => send(RELAY_FRAME.end, conn))
        socket.on('error', () => socket.destroy())
        socket.on('close', () => {
          send(RELAY_FRAME.close, conn)
          done()
        })
        socket.write(verdict.request)
      }
    },
    end(): void {
      if (state === 'reading') {
        reject(400)
      } else if (state === 'rejected') {
        send(RELAY_FRAME.close, conn)
        done()
      }
    },
    close(): void {
      upstream?.destroy()
      done()
    }
  }
}

function sameRoute(a: SandboxHookRoute, b: SandboxHookRoute): boolean {
  return a.vmPort === b.vmPort && a.hostPort === b.hostPort && a.hookToken === b.hookToken
}

type Relay = {
  child: ChildProcessWithoutNullStreams
  route: SandboxHookRoute
  handle: SandboxRelayHandle
  exited: boolean
}

function startRelay(
  machine: string,
  route: SandboxHookRoute,
  deps: RelayDeps,
  onExit: () => void
): Relay {
  const nonce = randomBytes(12).toString('hex')
  const spec = JSON.stringify({
    nonce,
    stateDir: deps.stateDir ?? RELAY_STATE_DIR,
    routes: [route.vmPort]
  })
  const child = deps.spawnAgent(machine, ['-I', '-c', SANDBOX_RELAY_AGENT_PY, spec])
  const conns = new Map<number, ReturnType<typeof hookConnection>>()
  const send: Send = (kind, conn, payload) =>
    !child.stdin.destroyed && child.stdin.write(encodeRelayFrame(kind, conn, payload))
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
      if (payload.readUInt8(0) !== 0) {
        send(RELAY_FRAME.close, conn)
        return
      }
      conns.set(
        conn,
        hookConnection(conn, route, send, dial, () => conns.delete(conn))
      )
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
  const relay: Relay = { child, route, handle: { nonce, ready }, exited: false }
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
      relay.child.stdin.end()
      relay.child.kill()
    }
  }

  /** Reuses the machine's live relay when its route matches; otherwise replaces it. */
  const ensure = (machine: string, route: SandboxHookRoute): SandboxRelayHandle => {
    const current = relays.get(machine)
    if (current && !current.exited && sameRoute(current.route, route)) {
      return current.handle
    }
    stop(machine)
    const relay = startRelay(machine, route, deps, () => {
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
