// node --test bench/lib/runtime-rpc.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import { describeApp } from './orca-instance.mjs'
import { rpc, rpcOk, runtimeMeta } from './runtime-rpc.mjs'

// Short base: a Unix socket path must stay under 104 bytes.
const scratch = () => mkdtempSync('/tmp/pb-rpc-')

test('rpc skips keepalives, passes the token, and rpcOk throws on an error reply', async () => {
  const dir = scratch()
  const endpoint = path.join(dir, 's.sock')
  const seen = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.on('data', (line) => {
      const request = JSON.parse(line)
      seen.push(request)
      socket.write(`${JSON.stringify({ _keepalive: true })}\n`)
      socket.write(
        request.method === 'fail'
          ? `${JSON.stringify({ id: request.id, ok: false, error: { code: 'nope' } })}\n`
          : `${JSON.stringify({ id: request.id, ok: true, result: { echo: request.params } })}\n`
      )
    })
  })
  await new Promise((resolve) => server.listen(endpoint, resolve))
  try {
    writeFileSync(
      path.join(dir, 'orca-runtime.json'),
      JSON.stringify({ authToken: 't0k', transports: [{ kind: 'unix', endpoint }] })
    )
    const meta = runtimeMeta({ ud: dir })
    const reply = await rpc(meta, 'browser.get', { what: 'title' })
    assert.deepEqual(reply.frame.result, { echo: { what: 'title' } })
    assert.ok(reply.ms > 0)
    assert.equal(seen[0].authToken, 't0k')
    await assert.rejects(rpcOk(meta, 'fail', {}), /fail: \{"code":"nope"\}/)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a checkout with an electron-vite build launches through its own Electron and CLI', () => {
  const dir = scratch()
  try {
    mkdirSync(path.join(dir, 'out/main'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules/electron'), { recursive: true })
    writeFileSync(path.join(dir, 'out/main/index.js'), '')
    writeFileSync(path.join(dir, 'package.json'), '{"version":"1.2.3"}')
    writeFileSync(path.join(dir, 'node_modules/electron/package.json'), '{"version":"45.0.0"}')
    const info = describeApp(dir)
    assert.equal(info.dev, true)
    assert.equal(info.version, '1.2.3')
    assert.equal(info.electron, '45.0.0')
    assert.match(
      info.executable,
      /node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron$/
    )
    assert.deepEqual(info.appArgs, [info.realPath])
    assert.deepEqual(info.cliArgs, [path.join(info.realPath, 'out/cli/index.js')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
