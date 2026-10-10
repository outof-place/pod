import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findAdoptableDaemons, moveLegacyDaemons } from './legacy-daemon-handover'

const DEAD_PID = 2_147_000_000
const RESTORE_SCRIPT = join(__dirname, '../../../product/scripts/restore-orca-terminals.mjs')

let root = ''
let orca = ''
let pod = ''
let servers: Server[] = []

beforeEach(() => {
  // Short base: Unix socket paths are capped at 104 bytes on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dh-')))
  orca = join(root, 'orca')
  pod = join(root, 'pod')
  mkdirSync(join(orca, 'daemon'), { recursive: true })
  mkdirSync(pod)
  servers = []
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  rmSync(root, { recursive: true, force: true })
})

async function liveDaemon(protocol: number, pid = process.pid): Promise<void> {
  const dir = join(orca, 'daemon')
  await new Promise<void>((resolve, reject) => {
    const server = createServer((socket) => socket.end(`v${protocol}`))
    servers.push(server)
    server.once('error', reject)
    server.listen(join(dir, `daemon-v${protocol}.sock`), () => resolve())
  })
  writeFileSync(join(dir, `daemon-v${protocol}.token`), `token-${protocol}`)
  writeFileSync(join(dir, `daemon-v${protocol}.pid`), JSON.stringify({ pid }))
}

function ask(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let data = ''
    socket.on('data', (chunk) => (data += String(chunk)))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

function move(legacyAppPid: number | null = null): ReturnType<typeof moveLegacyDaemons> {
  return moveLegacyDaemons({
    legacyUserData: orca,
    productUserData: pod,
    attachableDaemonProtocols: [39, 41, 42],
    legacyAppPid
  })
}

function writeMarker(moved: unknown[]): void {
  writeFileSync(
    join(pod, 'product-profile-migration.json'),
    JSON.stringify({ from: orca, daemonHandover: { decision: 'moved', moved } })
  )
}

function restore(): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [RESTORE_SCRIPT, pod], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('legacy daemon handover', () => {
  it('lists only live daemons of attachable protocols with a complete endpoint', async () => {
    await liveDaemon(41)
    await liveDaemon(39, DEAD_PID)
    await liveDaemon(99)
    // A dead socket without a pid record, like Orca's leftover v34/v36/v37.
    writeFileSync(join(orca, 'daemon/daemon-v34.sock'), '')

    expect(findAdoptableDaemons(orca, new Set([34, 39, 41, 42]))).toEqual([
      { protocol: 41, pid: process.pid }
    ])
  })

  it('refuses to move anything while the legacy app runs', async () => {
    await liveDaemon(41)
    expect(move(4242)).toEqual({ status: 'blocked', reason: 'legacy-app-running', pid: 4242 })
    expect(existsSync(join(orca, 'daemon/daemon-v41.sock'))).toBe(true)
  })

  it('moves a live endpoint so it answers only at the product path', async () => {
    await liveDaemon(41)
    await liveDaemon(42)
    writeFileSync(join(orca, 'daemon/daemon-v34.sock'), '')
    const inode = statSync(join(orca, 'daemon/daemon-v41.sock')).ino

    const result = move()

    expect(result).toMatchObject({ status: 'moved', skipped: [] })
    expect(result.status === 'moved' && result.moved.map(({ protocol }) => protocol)).toEqual([
      41, 42
    ])
    for (const extension of ['sock', 'token', 'pid']) {
      expect(existsSync(join(orca, `daemon/daemon-v41.${extension}`))).toBe(false)
      expect(existsSync(join(pod, `daemon/daemon-v41.${extension}`))).toBe(true)
    }
    expect(statSync(join(pod, 'daemon/daemon-v41.sock')).ino).toBe(inode)
    await expect(ask(join(pod, 'daemon/daemon-v41.sock'))).resolves.toBe('v41')
    // Never touched: the dead socket stays where it was.
    expect(existsSync(join(orca, 'daemon/daemon-v34.sock'))).toBe(true)
  })

  it('skips a daemon whose name is already taken in the product', async () => {
    await liveDaemon(41)
    mkdirSync(join(pod, 'daemon'))
    writeFileSync(join(pod, 'daemon/daemon-v41.token'), 'pod-own')

    expect(move()).toEqual({
      status: 'moved',
      moved: [],
      skipped: [{ protocol: 41, reason: 'product-endpoint-exists' }]
    })
    expect(readFileSync(join(pod, 'daemon/daemon-v41.token'), 'utf8')).toBe('pod-own')
    expect(existsSync(join(orca, 'daemon/daemon-v41.sock'))).toBe(true)
  })

  it('restores moved daemons, refusing while the product runs or when Orca took the name', async () => {
    await liveDaemon(41)
    await liveDaemon(42)
    const result = move()
    writeMarker(result.status === 'moved' ? result.moved : [])

    symlinkSync(`host.local-${process.pid}`, join(pod, 'SingletonLock'))
    expect(restore()).toMatchObject({ status: 2 })
    expect(existsSync(join(pod, 'daemon/daemon-v41.sock'))).toBe(true)
    rmSync(join(pod, 'SingletonLock'))

    // Orca started a fresh v42 daemon at its own path meanwhile.
    writeFileSync(join(orca, 'daemon/daemon-v42.token'), 'fresh')
    const { status, output } = restore()

    expect(output).toContain('restored daemon protocols: 41')
    expect(output).toContain('skipped v42: orca-endpoint-exists')
    expect(status).toBe(1)
    await expect(ask(join(orca, 'daemon/daemon-v41.sock'))).resolves.toBe('v41')
    expect(existsSync(join(pod, 'daemon/daemon-v41.sock'))).toBe(false)
    expect(readFileSync(join(orca, 'daemon/daemon-v42.token'), 'utf8')).toBe('fresh')
    const marker = JSON.parse(readFileSync(join(pod, 'product-profile-migration.json'), 'utf8'))
    expect(marker.daemonHandover).toMatchObject({ restored: [41], moved: [{ protocol: 42 }] })
  })
})
