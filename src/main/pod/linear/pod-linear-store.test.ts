// Fork-only (Pod): connect and disconnect go through the real SDK to the mock Linear server and keep
// the key in Pod's own store. Orca.app's files in ~/.orca are never read, written or deleted.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../../shared/secret-store'
import { POD_LINEAR_UNSEALED_MESSAGE } from './pod-linear-key-store'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'
import {
  guardFetchToLoopback,
  LINEAR_MOCK_ORGANIZATION,
  startLinearMockServer,
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const KEY = 'mock-linear-key-1'
const ORCA_KEY_BYTES = 'orca-app-sealed-key-bytes'
const saved = {
  apiUrl: process.env.POD_LINEAR_API_URL,
  profile: process.env.ORCA_E2E_USER_DATA_DIR
}

function restoreEnv(
  name: 'POD_LINEAR_API_URL' | 'ORCA_E2E_USER_DATA_DIR',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function tokenFileName(workspaceId: string): string {
  return `${Buffer.from(workspaceId).toString('base64url')}.enc`
}

/** Orca.app's Linear files, connected to the same organization the mock answers with. */
function writeOrcaLinearFiles(home: string): string {
  const orcaDir = join(home, '.orca')
  mkdirSync(join(orcaDir, 'linear-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'linear-tokens', tokenFileName(LINEAR_MOCK_ORGANIZATION.id)),
    ORCA_KEY_BYTES
  )
  writeFileSync(join(orcaDir, 'linear-token.enc'), ORCA_KEY_BYTES)
  writeFileSync(join(orcaDir, 'linear-viewer.json'), JSON.stringify({ displayName: 'Orca user' }))
  writeFileSync(
    join(orcaDir, 'linear-workspaces.json'),
    JSON.stringify({
      version: 1,
      activeWorkspaceId: LINEAR_MOCK_ORGANIZATION.id,
      selectedWorkspaceId: LINEAR_MOCK_ORGANIZATION.id,
      workspaces: [
        {
          id: LINEAR_MOCK_ORGANIZATION.id,
          organizationId: LINEAR_MOCK_ORGANIZATION.id,
          organizationName: LINEAR_MOCK_ORGANIZATION.name,
          displayName: 'Orca user',
          email: null
        }
      ]
    })
  )
  return orcaDir
}

/** Every file under dir with its sha256, so a test sees any write, rename or delete. */
function snapshot(
  dir: string,
  root = dir,
  files: Record<string, string> = {}
): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      snapshot(path, root, files)
    } else {
      files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  return files
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('Linear keys in Pod’s own store', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null
  let home = ''
  let userData = ''

  beforeEach(async () => {
    vi.resetModules()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    home = mkdtempSync(join(tmpdir(), 'pod-linear-home-'))
    userData = mkdtempSync(join(tmpdir(), 'pod-linear-user-data-'))
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => home }
    })
    setTestUserData(userData)
    setSecretStore(fakeKeychain())
    server = await startLinearMockServer()
    process.env.POD_LINEAR_API_URL = server.apiUrl
    process.env.ORCA_E2E_USER_DATA_DIR = userData
    guard = guardFetchToLoopback()
  })

  afterEach(async () => {
    guard?.restore()
    await server?.close()
    server = null
    restoreEnv('POD_LINEAR_API_URL', saved.apiUrl)
    restoreEnv('ORCA_E2E_USER_DATA_DIR', saved.profile)
    vi.doUnmock('os')
    vi.restoreAllMocks()
  })

  it('does not import Orca.app’s workspace or key', async () => {
    const orcaDir = writeOrcaLinearFiles(home)
    const before = snapshot(orcaDir)
    const linear = await import('../../linear/client')

    expect(linear.getStatus()).toMatchObject({ connected: false, workspaces: [] })
    expect(await linear.testConnection(LINEAR_MOCK_ORGANIZATION.id)).toEqual({
      ok: false,
      error: 'No API key stored.'
    })
    expect(server?.requests).toEqual([])
    expect(snapshot(orcaDir)).toEqual(before)
  })

  it('stores the key sealed in userData and leaves Orca.app’s files byte for byte', async () => {
    const orcaDir = writeOrcaLinearFiles(home)
    const before = snapshot(orcaDir)
    const storeDir = join(userData, 'integrations', 'linear')
    const keyPath = join(storeDir, 'linear-tokens', tokenFileName(LINEAR_MOCK_ORGANIZATION.id))
    const linear = await import('../../linear/client')

    const connected = await linear.connect(KEY)

    expect(connected).toMatchObject({ ok: true, workspace: { id: LINEAR_MOCK_ORGANIZATION.id } })
    expect(readFileSync(keyPath).includes(KEY)).toBe(false)
    expect(modeOf(storeDir)).toBe(0o700)
    expect(modeOf(join(storeDir, 'linear-tokens'))).toBe(0o700)
    expect(modeOf(keyPath)).toBe(0o600)
    expect(modeOf(join(storeDir, 'linear-workspaces.json'))).toBe(0o600)
    expect(server?.requests.every((request) => request.authorization === KEY)).toBe(true)
    expect(snapshot(orcaDir)).toEqual(before)

    linear.disconnect(LINEAR_MOCK_ORGANIZATION.id)

    expect(existsSync(keyPath)).toBe(false)
    expect(linear.getStatus()).toMatchObject({ connected: false })
    expect(snapshot(orcaDir)).toEqual(before)
    expect(guard?.blocked).toEqual([])
  })

  it('fails the connect and stores nothing when the keychain cannot seal', async () => {
    const orcaDir = writeOrcaLinearFiles(home)
    const before = snapshot(orcaDir)
    setSecretStore(fakeKeychain({ isEncryptionAvailable: () => false }))
    const linear = await import('../../linear/client')

    expect(await linear.connect(KEY)).toEqual({ ok: false, error: POD_LINEAR_UNSEALED_MESSAGE })
    expect(snapshot(join(userData, 'integrations', 'linear'))).toEqual({})
    expect(linear.getStatus()).toMatchObject({ connected: false })
    expect(snapshot(orcaDir)).toEqual(before)
  })
})
