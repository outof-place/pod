// A stdio MCP server for mcp-lazy-shim.test.ts: a fixed initialize, a tool list chosen by
// FAKE_TOOLS, a tools/call that logs and asks the client for roots before answering,
// FAKE_MODE=exit|hang for start failures, FAKE_CHILD (a child in its process group, as Chrome is
// for chrome-devtools), FAKE_RECV (every line it receives) and FAKE_PIDFILE.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE ?? ''
if (mode === 'exit') {
  process.exit(3)
}
if (process.env.FAKE_PIDFILE) {
  writeFileSync(process.env.FAKE_PIDFILE, String(process.pid))
}
if (process.env.FAKE_CHILD) {
  const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
  writeFileSync(process.env.FAKE_CHILD, String(child.pid))
}
const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }]
if (process.env.FAKE_TOOLS === 'two') {
  tools.push({ name: 'second', description: 'Another', inputSchema: { type: 'object' } })
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let pending = null
createInterface({ input: process.stdin }).on('line', (line) => {
  if (process.env.FAKE_RECV) {
    appendFileSync(process.env.FAKE_RECV, `${line}\n`)
  }
  const message = JSON.parse(line)
  const { method, id } = message
  if (method === 'initialize') {
    if (mode !== 'hang') {
      send({
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: 'fake', version: '1.0.0' },
          instructions: 'Fake server — ünïcode ✓'
        },
        jsonrpc: '2.0',
        id
      })
    }
  } else if (method === 'tools/list') {
    send({ result: { tools }, jsonrpc: '2.0', id })
  } else if (method === 'ping') {
    send({ result: {}, jsonrpc: '2.0', id })
  } else if (method === 'tools/call') {
    send({
      method: 'notifications/message',
      params: { level: 'info', data: 'called' },
      jsonrpc: '2.0'
    })
    send({ method: 'roots/list', jsonrpc: '2.0', id: 'srv-1' })
    pending = id
  } else if (method === undefined && id === 'srv-1') {
    send({
      result: { content: [{ type: 'text', text: JSON.stringify(message.result) }] },
      jsonrpc: '2.0',
      id: pending
    })
  } else if (method !== undefined && id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
  }
})
