// The native shim (native/mcp-lazy-macos) against a fake stdio server: frames byte for byte from
// the manifest, the start on first use with server frames passed through, start failures as
// errors, a changed tool list, and the server's process group going with the session.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SOURCE = join(import.meta.dirname, '../../../../native/mcp-lazy-macos/src/mcp-lazy.c')
const FAKE = join(import.meta.dirname, '__fixtures__/fake-mcp-server.mjs')
const canBuild = process.platform === 'darwin' && existsSync('/usr/bin/clang')

const DISCOVER =
  '{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"t","version":"1"}}}}'
const INIT =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{}},"clientInfo":{"name":"t","version":"1"}}}'
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
const TOOLS = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
const CALL =
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{}}}'

let dir: string
let shim: string

class Peer {
  readonly child: ChildProcessWithoutNullStreams
  private readonly lines: string[] = []
  private waiting: ((line: string | null) => void) | null = null
  private ended = false

  constructor(argv: string[], env: Record<string, string> = {}) {
    this.child = spawn(argv[0], argv.slice(1), {
      env: {
        ...process.env,
        MCP_LAZY_CACHE: join(dir, 'cache'),
        MCP_LAZY_LOG: join(dir, 'log'),
        FAKE_PIDFILE: join(dir, 'pid'),
        ...env
      }
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.push(line))
    this.child.stdout.on('end', () => {
      this.ended = true
      this.push(null)
    })
  }

  private push(line: string | null): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve(line)
    } else if (line !== null) {
      this.lines.push(line)
    }
  }

  read(timeoutMs = 10_000): Promise<string | null> {
    const next = this.lines.shift()
    if (next !== undefined || this.ended) {
      return Promise.resolve(next ?? null)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null
        resolve(null)
      }, timeoutMs)
      this.waiting = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }

  send(line: string): void {
    this.child.stdin.write(`${line}\n`)
  }

  ask(line: string, timeoutMs?: number): Promise<string | null> {
    this.send(line)
    return this.read(timeoutMs)
  }

  close(): Promise<void> {
    this.child.stdin.end()
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
      } else {
        this.child.on('exit', () => resolve())
      }
    })
  }
}

const server = (env: Record<string, string> = {}): Peer => new Peer([process.execPath, FAKE], env)
const lazy = (env: Record<string, string> = {}): Peer =>
  new Peer([shim, 'fake', process.execPath, FAKE], env)

function alive(pidFile: string): boolean {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!canBuild)('mcp-lazy shim', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-lazy-shim-'))
    shim = join(dir, 'mcp-lazy')
    execFileSync('/usr/bin/clang', [
      '-Os',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Wno-unused-result',
      '-Werror',
      SOURCE,
      '-o',
      shim
    ])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    rmSync(join(dir, 'cache'), { recursive: true, force: true })
    rmSync(join(dir, 'pid'), { force: true })
  })

  async function reference(): Promise<{
    discover: string | null
    init: string | null
    tools: string | null
  }> {
    const direct = server()
    const discover = await direct.ask(DISCOVER)
    const init = await direct.ask(INIT)
    direct.send(INITIALIZED)
    const tools = await direct.ask(TOOLS)
    await direct.close()
    return { discover, init, tools }
  }

  async function prime(): Promise<void> {
    const miss = lazy()
    await miss.ask(DISCOVER)
    await miss.ask(INIT)
    miss.send(INITIALIZED)
    await miss.ask(TOOLS)
    await miss.close()
  }

  it('records the server through a first session, then answers the handshake byte for byte with no server', async () => {
    const ref = await reference()
    const miss = lazy()
    expect(await miss.ask(DISCOVER)).toBe(ref.discover)
    expect(await miss.ask(INIT)).toBe(ref.init)
    miss.send(INITIALIZED)
    expect(await miss.ask(TOOLS)).toBe(ref.tools)
    expect(alive(join(dir, 'pid'))).toBe(true)
    await miss.close()
    const [manifest] = readdirSync(join(dir, 'cache'))
    expect(statSync(join(dir, 'cache', manifest)).mode & 0o777).toBe(0o600)

    rmSync(join(dir, 'pid'), { force: true })
    const hit = lazy()
    expect(await hit.ask(DISCOVER.replace('"version":"1"', '"version":"9"'))).toBe(ref.discover)
    expect(await hit.ask(INIT)).toBe(ref.init)
    hit.send(INITIALIZED)
    const other = await hit.ask(TOOLS.replace('"id":1', '"id":"x-7"'))
    expect(other).toBe(ref.tools?.replace('"id":1', '"id":"x-7"'))
    await sleep(200)
    expect(existsSync(join(dir, 'pid'))).toBe(false)
    await hit.close()
  })

  it('starts the server at the first call: ids untouched, its notification and request passed through', async () => {
    await prime()
    const received = join(dir, 'received')
    const session = lazy({ FAKE_RECV: received })
    await session.ask(INIT)
    session.send(INITIALIZED)
    await session.ask(TOOLS)
    session.send(CALL)
    expect(JSON.parse((await session.read()) ?? '{}').method).toBe('notifications/message')
    expect(JSON.parse((await session.read()) ?? '{}').method).toBe('roots/list')
    session.send('{"jsonrpc":"2.0","id":"srv-1","result":{"roots":[{"uri":"file:///tmp"}]}}')
    const answer = JSON.parse((await session.read()) ?? '{}')
    expect(answer.id).toBe(4)
    expect(JSON.stringify(answer)).toContain('file:///tmp')
    await session.close()
    const calls = readFileSync(received, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"tools/call"'))
    expect(calls.map((line) => JSON.parse(line).id)).toEqual([4])
  })

  it('answers a call with an error when the server exits or never answers initialize', async () => {
    await prime()
    for (const [mode, timeout] of [
      ['exit', '60'],
      ['hang', '1']
    ]) {
      const session = lazy({ FAKE_MODE: mode, MCP_LAZY_START_TIMEOUT: timeout })
      await session.ask(INIT)
      session.send(INITIALIZED)
      const error = JSON.parse((await session.ask(CALL, 15_000)) ?? '{}')
      expect(error.id).toBe(4)
      expect(error.error.message).toContain('did not start')
      await session.close()
    }
  })

  it('tells the session when the started server lists other tools, and drops the manifest', async () => {
    await prime()
    const session = lazy({ FAKE_TOOLS: 'two' })
    await session.ask(INIT)
    session.send(INITIALIZED)
    await session.ask(TOOLS)
    session.send(CALL)
    const seen = [await session.read(), await session.read(), await session.read()]
    expect(seen.some((line) => line?.includes('notifications/tools/list_changed'))).toBe(true)
    await session.close()
    expect(readdirSync(join(dir, 'cache')).filter((name) => !name.startsWith('.'))).toEqual([])
  })

  it("takes the server's own children with it when the session closes", async () => {
    const childFile = join(dir, 'child')
    const session = lazy({ FAKE_CHILD: childFile })
    await session.ask(INIT)
    for (let i = 0; i < 50 && !existsSync(childFile); i++) {
      await sleep(50)
    }
    expect(alive(childFile)).toBe(true)
    await session.close()
    await sleep(300)
    expect(alive(childFile)).toBe(false)
  })
})
