// A scripted stand-in for the runtime's owner unix socket, so the parity harness can run the
// Node CLI and native podx against identical, deterministic responses and record every request.
// The harness writes <dir>/scenario.json before each run; this server re-reads it per request.
import { createServer } from 'node:net'
import { appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const dir = process.argv[2]
const runtimeId = 'rt-parity-0001'
const authToken = randomBytes(24).toString('base64url')
const endpoint = join(dir, 'o-parity.sock')
rmSync(endpoint, { force: true })

const counters = new Map()

function scenario() {
  try {
    return JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))
  } catch {
    return { responses: {} }
  }
}

function nextSpec(method) {
  const s = scenario()
  const list = s.responses?.[method] ??
    s.responses?.['*'] ?? [
      {
        error: {
          code: 'method_not_found',
          message: `Unknown method: ${method}`
        }
      }
    ]
  const used = counters.get(method) ?? 0
  counters.set(method, used + 1)
  return list[Math.min(used, list.length - 1)]
}

const server = createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += chunk
    const nl = buffer.indexOf('\n')
    if (nl === -1) {
      return
    }
    const line = buffer.slice(0, nl)
    buffer = ''
    let request
    try {
      request = JSON.parse(line)
    } catch {
      socket.destroy()
      return
    }
    const { id, authToken: token, method, ...rest } = request
    appendFileSync(
      join(dir, 'requests.jsonl'),
      `${JSON.stringify({ method, ...rest, authOk: token === authToken })}\n`
    )
    respond(socket, id, nextSpec(method))
  })
})

function respond(socket, id, spec) {
  const write = (frame) =>
    socket.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`)
  const meta = { runtimeId: spec.metaRuntimeId ?? runtimeId }
  const finish = () => {
    if (spec.close) {
      socket.end()
      return
    }
    if (spec.reset) {
      socket.resetAndDestroy()
      return
    }
    if (spec.hang) {
      return
    }
    if (spec.raw !== undefined) {
      write(spec.raw.replaceAll('__ID__', id))
      return
    }
    const frameId = spec.idMismatch ? 'not-the-request-id' : id
    if (spec.error) {
      write({
        id: frameId,
        ok: false,
        error: spec.error,
        ...(spec.noMeta ? {} : { _meta: spec.failureMeta ?? meta })
      })
    } else {
      write({
        id: frameId,
        ok: true,
        ...('result' in spec ? { result: spec.result } : {}),
        ...spec.extra,
        ...(spec.noMeta ? {} : { _meta: meta })
      })
    }
    if (!spec.keepOpen) {
      socket.end()
    }
  }
  const keepalives = spec.keepalives ?? 0
  let sent = 0
  const tick = () => {
    if (sent < keepalives) {
      sent += 1
      write({ _keepalive: true })
      setTimeout(tick, spec.keepaliveIntervalMs ?? 5)
      return
    }
    if (spec.delayMs) {
      setTimeout(finish, spec.delayMs)
    } else {
      finish()
    }
  }
  tick()
}

server.listen(endpoint, () => {
  writeFileSync(
    join(dir, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId,
      pid: process.pid,
      transports: [{ kind: 'unix', endpoint }],
      authToken,
      startedAt: Date.now()
    })
  )
  process.stdout.write('ready\n')
})

process.on('message', (msg) => {
  if (msg === 'reset') {
    counters.clear()
    process.send?.('reset-done')
  }
})
