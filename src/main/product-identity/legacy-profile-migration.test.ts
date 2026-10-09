import { createServer, createConnection, type Server } from 'node:net'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrateLegacyProfile,
  PRODUCT_MIGRATION_MARKER,
  type LegacyProfileMigrationOptions,
  type SafeStorageKeychainPort
} from './legacy-profile-migration'

const LEGACY_SECRET = 'c2FsdHlzYWx0eXNhbHR5c2FsdA=='
const DEAD_PID = 2_147_000_000

let root: string
let servers: Server[]

function listTree(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      out.push(relative(dir, path))
      if (lstatSync(path).isDirectory()) {
        walk(path)
      }
    }
  }
  walk(dir)
  return out.sort()
}

function listen(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end('pong'))
    servers.push(server)
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
}

function readThroughSocket(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let data = ''
    socket.on('data', (chunk) => (data += String(chunk)))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

class FakeKeychain implements SafeStorageKeychainPort {
  readonly items = new Map<string, string>()
  readonly reads: string[] = []
  writes: { service: string; trustedAppPath: string | null }[] = []
  constructor(private readonly denyReads = false) {}
  hasItem(service: string, account: string): boolean {
    return this.items.has(`${service}/${account}`)
  }
  readSecret(service: string, account: string): string | null {
    this.reads.push(service)
    return this.denyReads ? null : (this.items.get(`${service}/${account}`) ?? null)
  }
  writeSecret(
    service: string,
    account: string,
    secret: string,
    trustedAppPath: string | null
  ): void {
    this.items.set(`${service}/${account}`, secret)
    this.writes.push({ service, trustedAppPath })
  }
}

/** A legacy Orca profile with state, caches, a live and a dead daemon, and a stray socket. */
async function createLegacyProfile(legacy: string): Promise<void> {
  mkdirSync(join(legacy, 'profiles', 'local-default'), { recursive: true })
  writeFileSync(join(legacy, 'orca-data.json'), '{"repos":[]}')
  writeFileSync(join(legacy, 'orca-profile-index.json'), '{}')
  writeFileSync(join(legacy, 'profiles', 'local-default', 'profile-state.db'), 'SQLite format 3')
  writeFileSync(join(legacy, 'profiles', 'local-default', 'profile-state.db-wal'), 'wal')
  mkdirSync(join(legacy, 'Cache', 'Cache_Data'), { recursive: true })
  writeFileSync(join(legacy, 'Cache', 'Cache_Data', 'blob'), 'cached')
  mkdirSync(join(legacy, 'terminal-history'))
  writeFileSync(join(legacy, 'terminal-history', 'scrollback.bin'), 'history')
  symlinkSync(`host.local-${DEAD_PID}`, join(legacy, 'SingletonLock'))
  symlinkSync('orca-data.json', join(legacy, 'relative-link'))
  await listen(join(legacy, 'o-1-abc.sock'))

  const daemon = join(legacy, 'daemon')
  mkdirSync(daemon)
  // Live attachable daemon (this test process stands in for it).
  await listen(join(daemon, 'daemon-v41.sock'))
  writeFileSync(join(daemon, 'daemon-v41.token'), 'token-41')
  writeFileSync(join(daemon, 'daemon-v41.pid'), JSON.stringify({ pid: process.pid }))
  // Dead daemon: left behind.
  writeFileSync(join(daemon, 'daemon-v39.sock'), '')
  writeFileSync(join(daemon, 'daemon-v39.token'), 'token-39')
  writeFileSync(join(daemon, 'daemon-v39.pid'), JSON.stringify({ pid: DEAD_PID }))
  // Live but from a protocol this build cannot attach.
  await listen(join(daemon, 'daemon-v99.sock'))
  writeFileSync(join(daemon, 'daemon-v99.token'), 'token-99')
  writeFileSync(join(daemon, 'daemon-v99.pid'), JSON.stringify({ pid: process.pid }))
}

function baseOptions(keychain: SafeStorageKeychainPort | null): LegacyProfileMigrationOptions {
  return {
    legacyUserData: join(root, 'orca'),
    productUserData: join(root, 'pod'),
    legacyKeychainName: 'orca',
    productKeychainName: 'pod',
    trustedAppPath: '/Applications/Pod.app',
    keychain,
    attachableDaemonProtocols: [39, 41, 43],
    appVersion: '1.0.0-test',
    isProcessAlive: (pid) => pid === process.pid,
    now: () => new Date('2026-10-09T12:00:00Z')
  }
}

beforeEach(() => {
  // Short base: Unix socket paths are capped at 104 bytes on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-')))
  servers = []
})

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  rmSync(root, { recursive: true, force: true })
})

describe('migrateLegacyProfile', () => {
  it('clones state, links live attachable daemons and adopts the legacy safeStorage key', async () => {
    const legacy = join(root, 'orca')
    await createLegacyProfile(legacy)
    const legacyBefore = listTree(legacy)
    const keychain = new FakeKeychain()
    keychain.items.set('orca Safe Storage/orca Key', LEGACY_SECRET)

    const result = migrateLegacyProfile(baseOptions(keychain))

    expect(result).toEqual({ status: 'imported', linkedDaemons: [41], safeStorage: 'adopted' })
    const pod = join(root, 'pod')
    expect(readFileSync(join(pod, 'orca-data.json'), 'utf8')).toBe('{"repos":[]}')
    expect(readFileSync(join(pod, 'profiles/local-default/profile-state.db-wal'), 'utf8')).toBe(
      'wal'
    )
    expect(readFileSync(join(pod, 'terminal-history/scrollback.bin'), 'utf8')).toBe('history')
    expect(readlinkSync(join(pod, 'relative-link'))).toBe('orca-data.json')
    // Caches, Chromium's lock and live sockets are not carried over.
    expect(existsSync(join(pod, 'Cache'))).toBe(false)
    expect(existsSync(join(pod, 'SingletonLock'))).toBe(false)
    expect(existsSync(join(pod, 'o-1-abc.sock'))).toBe(false)
    // Only the live v41 daemon is handed over, by symlink, and it still answers through the link.
    expect(readdirSync(join(pod, 'daemon')).sort()).toEqual([
      'daemon-v41.pid',
      'daemon-v41.sock',
      'daemon-v41.token'
    ])
    expect(readlinkSync(join(pod, 'daemon/daemon-v41.sock'))).toBe(
      join(legacy, 'daemon/daemon-v41.sock')
    )
    await expect(readThroughSocket(join(pod, 'daemon/daemon-v41.sock'))).resolves.toBe('pong')
    // The new keychain item carries the legacy secret and trusts the product app.
    expect(keychain.items.get('pod Safe Storage/pod Key')).toBe(LEGACY_SECRET)
    expect(keychain.writes).toEqual([
      { service: 'pod Safe Storage', trustedAppPath: '/Applications/Pod.app' }
    ])
    const marker = JSON.parse(readFileSync(join(pod, PRODUCT_MIGRATION_MARKER), 'utf8'))
    expect(marker).toMatchObject({
      from: legacy,
      at: '2026-10-09T12:00:00.000Z',
      linkedDaemons: [41],
      safeStorage: 'adopted',
      permissionsNoticeShown: false
    })
    // Rollback stays possible: the legacy profile is byte-for-byte where it was.
    expect(listTree(legacy)).toEqual(legacyBefore)
    expect(existsSync(join(root, '.pod.migrating'))).toBe(false)
  })

  it('refuses to copy while the legacy app holds its profile lock', async () => {
    const legacy = join(root, 'orca')
    await createLegacyProfile(legacy)
    rmSync(join(legacy, 'SingletonLock'))
    symlinkSync(`host.local-${process.pid}`, join(legacy, 'SingletonLock'))

    expect(migrateLegacyProfile(baseOptions(new FakeKeychain()))).toEqual({
      status: 'blocked',
      reason: 'legacy-app-running',
      pid: process.pid
    })
    expect(existsSync(join(root, 'pod'))).toBe(false)
  })

  it('leaves an existing product profile alone', async () => {
    await createLegacyProfile(join(root, 'orca'))
    mkdirSync(join(root, 'pod'))
    writeFileSync(join(root, 'pod', 'orca-data.json'), '{"mine":true}')

    expect(migrateLegacyProfile(baseOptions(new FakeKeychain()))).toEqual({
      status: 'not-needed',
      reason: 'product-profile-exists'
    })
    expect(readFileSync(join(root, 'pod', 'orca-data.json'), 'utf8')).toBe('{"mine":true}')
  })

  it('imports into a userData that only holds Chromium bootstrap files', async () => {
    await createLegacyProfile(join(root, 'orca'))
    mkdirSync(join(root, 'pod', 'Crashpad'), { recursive: true })

    const result = migrateLegacyProfile(baseOptions(null))

    expect(result).toMatchObject({ status: 'imported', safeStorage: 'not-applicable' })
    expect(existsSync(join(root, 'pod', 'Crashpad'))).toBe(true)
    expect(existsSync(join(root, 'pod', 'orca-data.json'))).toBe(true)
    expect(existsSync(join(root, 'pod', PRODUCT_MIGRATION_MARKER))).toBe(true)
  })

  it('still imports the profile when keychain access is denied', async () => {
    await createLegacyProfile(join(root, 'orca'))
    const keychain = new FakeKeychain(true)
    keychain.items.set('orca Safe Storage/orca Key', LEGACY_SECRET)

    const result = migrateLegacyProfile(baseOptions(keychain))

    expect(result).toMatchObject({ status: 'imported', safeStorage: 'unavailable' })
    expect(keychain.writes).toEqual([])
  })

  it('does not overwrite a product keychain item that already exists', async () => {
    await createLegacyProfile(join(root, 'orca'))
    const keychain = new FakeKeychain()
    keychain.items.set('orca Safe Storage/orca Key', LEGACY_SECRET)
    keychain.items.set('pod Safe Storage/pod Key', 'cHJvZHVjdC1zZWNyZXQ=')

    expect(migrateLegacyProfile(baseOptions(keychain))).toMatchObject({
      safeStorage: 'already-present'
    })
    expect(keychain.reads).toEqual([])
  })

  it('waits for a concurrent first launch and resumes after a crashed one', async () => {
    await createLegacyProfile(join(root, 'orca'))
    const staging = join(root, '.pod.migrating')
    mkdirSync(staging)
    writeFileSync(join(staging, '.owner'), JSON.stringify({ pid: 4242 }))
    const options = baseOptions(null)

    expect(migrateLegacyProfile({ ...options, isProcessAlive: (pid) => pid !== DEAD_PID })).toEqual(
      {
        status: 'blocked',
        reason: 'migration-in-progress',
        pid: 4242
      }
    )
    expect(migrateLegacyProfile(options)).toMatchObject({ status: 'imported' })
  })

  it('does nothing without a legacy profile', () => {
    expect(migrateLegacyProfile(baseOptions(new FakeKeychain()))).toEqual({
      status: 'not-needed',
      reason: 'no-legacy-profile'
    })
    expect(existsSync(join(root, 'pod'))).toBe(false)
  })
})
