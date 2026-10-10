// The app's runtime RPC as its CLI speaks it: one newline-framed JSON request per connection on
// the Unix socket that `orca-runtime.json` in the profile names.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'

export function runtimeMeta(profile) {
  const meta = JSON.parse(readFileSync(path.join(profile.ud, 'orca-runtime.json'), 'utf8'))
  const endpoint = meta.transports?.find((transport) => transport.kind === 'unix')?.endpoint
  if (!endpoint) {
    throw new Error('orca-runtime.json names no unix transport')
  }
  return { endpoint, authToken: meta.authToken }
}

/** One request; resolves with the reply frame and the wall time from connect to reply. */
export function rpc(meta, method, params = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const socket = createConnection(meta.endpoint)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${method}: no reply in ${timeoutMs} ms`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ id: randomUUID(), authToken: meta.authToken, method, params })}\n`
      )
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const frame = JSON.parse(line)
        // Long calls send keepalives before the reply.
        if (frame._keepalive) {
          continue
        }
        clearTimeout(timer)
        socket.end()
        resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, frame, bytes: line.length })
        return
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** rpc() that throws unless the app answered ok. */
export async function rpcOk(meta, method, params, timeoutMs) {
  const reply = await rpc(meta, method, params, timeoutMs)
  if (!reply.frame.ok) {
    throw new Error(`${method}: ${JSON.stringify(reply.frame.error).slice(0, 400)}`)
  }
  return reply
}
