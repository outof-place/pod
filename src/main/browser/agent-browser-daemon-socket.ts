import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { resolveAgentBrowserSocketDirectory } from './agent-browser-session-reset'
import type { AgentBrowserDaemonCommand } from './agent-browser-daemon-command'

// The daemon protocol this module speaks; another minor keeps the CLI process.
const SUPPORTED_DAEMON_VERSION = /^0\.27\.\d+$/

export type AgentBrowserDaemonEndpoint = { path: string } | { host: '127.0.0.1'; port: number }

/** No daemon listens for the session (exited or never started): the CLI starts one. */
export class AgentBrowserDaemonUnreachable extends Error {}

/** The daemon did not answer within the command's timeout. */
export class AgentBrowserDaemonTimeout extends Error {}

/** The command was cancelled (its tab closed) before the daemon answered. */
export class AgentBrowserDaemonCancelled extends Error {}

// agent-browser's Windows port for a session name without a `.port` file (connection.rs).
function hashedSessionPort(sessionName: string): number {
  let hash = 0
  for (const char of sessionName) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0
  }
  return 49152 + (Math.abs(hash) % 16383)
}

/** Where the CLI would connect for `sessionName`: its unix socket, or its loopback port on Windows. */
export function agentBrowserDaemonEndpoint(
  env: NodeJS.ProcessEnv,
  sessionName: string,
  platform: NodeJS.Platform = process.platform
): AgentBrowserDaemonEndpoint {
  const directory = resolveAgentBrowserSocketDirectory(env)
  if (platform !== 'win32') {
    return { path: join(directory, `${sessionName}.sock`) }
  }
  let port = hashedSessionPort(sessionName)
  try {
    const written = Number(readFileSync(join(directory, `${sessionName}.port`), 'utf8').trim())
    if (Number.isInteger(written) && written > 0 && written < 65536) {
      port = written
    }
  } catch {
    // No .port file yet: the CLI uses the hashed port too.
  }
  return { host: '127.0.0.1', port }
}

/** True when the session's daemon speaks the protocol `agentBrowserDaemonCommand` writes. */
export function agentBrowserDaemonSpeaksSupportedProtocol(
  env: NodeJS.ProcessEnv,
  sessionName: string
): boolean {
  try {
    const version = readFileSync(
      join(resolveAgentBrowserSocketDirectory(env), `${sessionName}.version`),
      'utf8'
    ).trim()
    return SUPPORTED_DAEMON_VERSION.test(version)
  } catch {
    return false
  }
}

const UNREACHABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'ECONNRESET', 'EPIPE'])

export type AgentBrowserDaemonExchange = {
  /** The daemon's reply line, as the CLI prints it with `--json`. */
  reply: Promise<string>
  cancel: () => void
}

/**
 * One command over the session's daemon socket: one connection, one JSON line each way, as the
 * CLI does (connection.rs `send_command_once`) without the CLI's process start.
 */
export function exchangeAgentBrowserDaemonCommand(
  endpoint: AgentBrowserDaemonEndpoint,
  daemonCommand: AgentBrowserDaemonCommand,
  timeoutMs: number
): AgentBrowserDaemonExchange {
  let socket: Socket | null = null
  let cancel = (): void => {}
  const reply = new Promise<string>((resolve, reject) => {
    let settled = false
    let sent = false
    const chunks: Buffer[] = []
    const finish = (error: Error | null, line?: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(line ?? '')
      }
    }
    const timer = setTimeout(
      () => finish(new AgentBrowserDaemonTimeout('Browser command timed out')),
      timeoutMs
    )
    cancel = () => finish(new AgentBrowserDaemonCancelled('Tab was closed while command was running'))
    socket = 'path' in endpoint ? createConnection(endpoint.path) : createConnection(endpoint)
    socket.on('connect', () => {
      sent = true
      socket?.write(`${JSON.stringify(daemonCommand)}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      const newline = chunk.indexOf(10)
      if (newline === -1) {
        chunks.push(chunk)
        return
      }
      chunks.push(chunk.subarray(0, newline))
      finish(null, Buffer.concat(chunks).toString('utf8'))
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // Why only before sending: after it the daemon may have run the command, and a second run (a click) is worse than an error.
      finish(
        !sent && error.code && UNREACHABLE_CODES.has(error.code)
          ? new AgentBrowserDaemonUnreachable(error.message)
          : error
      )
    })
    socket.on('close', () =>
      finish(
        sent
          ? new Error('agent-browser closed the connection before answering')
          : new AgentBrowserDaemonUnreachable('agent-browser daemon closed the connection')
      )
    )
  })
  return { reply, cancel: () => cancel() }
}
