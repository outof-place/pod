import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { turnLinearOnInFreshModules } from '../pod/linear/pod-linear-access.test-support'

type ViewerFixture = {
  displayName: string
  email: string | null
  organizationId: string
  organizationName: string
  organizationUrlKey: string
}

let tempHome = ''
// Fork-only (Pod): Linear's files live in Pod's userData, not in ~/.orca.
let tempUserData = ''
let fixtures = new Map<string, ViewerFixture>()
let linearClientMock: ReturnType<typeof vi.fn>

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

function writeLegacyLinearFiles(token: string, viewer: Record<string, unknown>): void {
  writeLegacyLinearToken(token, viewer)
}

function linearStoreDir(): string {
  return join(tempUserData, 'integrations', 'linear')
}

function writeLegacyLinearToken(token: string | Buffer, viewer: Record<string, unknown>): void {
  const orcaDir = linearStoreDir()
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'linear-token.enc'), token)
  writeFileSync(join(orcaDir, 'linear-viewer.json'), JSON.stringify(viewer), {
    encoding: 'utf-8'
  })
}

function workspaceTokenPath(workspaceId: string): string {
  return join(
    linearStoreDir(),
    'linear-tokens',
    `${Buffer.from(workspaceId).toString('base64url')}.enc`
  )
}

function writeMultiWorkspaceFiles(
  workspaces: { id: string; token: string | Buffer }[],
  selectedWorkspaceId: string
): void {
  const orcaDir = linearStoreDir()
  mkdirSync(join(orcaDir, 'linear-tokens'), { recursive: true })
  writeFileSync(
    join(orcaDir, 'linear-workspaces.json'),
    JSON.stringify({
      version: 1,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      selectedWorkspaceId,
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        organizationId: workspace.id,
        organizationName: workspace.id,
        displayName: 'Ada',
        email: 'ada@example.com'
      }))
    }),
    { encoding: 'utf-8' }
  )
  for (const workspace of workspaces) {
    writeFileSync(workspaceTokenPath(workspace.id), workspace.token)
  }
}

async function loadClientModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  linearClientMock = vi.fn(function LinearClient(
    this: { viewer: Promise<unknown> },
    { apiKey }: { apiKey: string }
  ) {
    const fixture = fixtures.get(apiKey)
    if (!fixture) {
      throw new Error('Invalid API key')
    }
    this.viewer = Promise.resolve({
      displayName: fixture.displayName,
      email: fixture.email,
      organization: Promise.resolve({
        id: fixture.organizationId,
        name: fixture.organizationName,
        urlKey: fixture.organizationUrlKey
      })
    })
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  const { setAppEnvironment } = await import('../../shared/app-environment')
  setAppEnvironment({
    getPath: () => tempUserData,
    getAppPath: () => tempUserData,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  setSecretStore({
    // Fork-only (Pod): Pod stores keys only sealed, so the fake keychain seals by default.
    isEncryptionAvailable: () => options.encryptionAvailable ?? true,
    encryptString: (value) => Buffer.from(value),
    decryptString: options.decryptString ?? ((value) => value.toString('utf-8')),
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  class AuthenticationLinearError extends Error {}
  // Why: client.ts loads @linear/sdk lazily via ./linear-sdk (createRequire) to
  // keep it off the startup parse path; mock the loader, not the raw module.
  vi.doMock('./linear-sdk', () => ({
    loadLinearSdk: () => ({
      AuthenticationLinearError,
      LinearClient: linearClientMock
    })
  }))
  // Fork-only (Pod): status reads nothing while the podLinear setting is off.
  await turnLinearOnInFreshModules()

  return import('./client')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-linear-client-')
  tempUserData = mkdtempLike('pod-linear-user-data-')
  fixtures = new Map([
    [
      'token-alpha',
      {
        displayName: 'Ada',
        email: 'ada@example.com',
        organizationId: 'org-alpha',
        organizationName: 'Alpha',
        organizationUrlKey: 'alpha'
      }
    ],
    [
      'token-beta',
      {
        displayName: 'Grace',
        email: 'grace@example.com',
        organizationId: 'org-beta',
        organizationName: 'Beta',
        organizationUrlKey: 'beta'
      }
    ]
  ])
  vi.restoreAllMocks()
})

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('Linear client workspace storage', () => {
  it('forwards an optional detail deadline to both SDK clients', async () => {
    const linear = await loadClientModule()
    await linear.connect('token-alpha')
    const signal = new AbortController().signal
    const entry = linear.getClients('org-alpha', signal)[0]
    expect(linearClientMock).toHaveBeenLastCalledWith({ apiKey: 'token-alpha', signal })
    linear.getPublicFileUrlClient(entry, signal)
    expect(linearClientMock).toHaveBeenLastCalledWith({
      apiKey: 'token-alpha',
      signal,
      headers: {
        'public-file-urls-expire-in': String(linear.LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
      }
    })
  })
  it('requests temporary file URLs using only the selected workspace credential', async () => {
    const linear = await loadClientModule()
    await linear.connect('token-alpha')
    await linear.connect('token-beta')
    const entry = linear.getClients('org-alpha')[0]
    linear.getPublicFileUrlClient(entry)
    expect(linearClientMock).toHaveBeenLastCalledWith({
      apiKey: 'token-alpha',
      headers: {
        'public-file-urls-expire-in': String(linear.LINEAR_PUBLIC_FILE_URL_EXPIRY_SECONDS)
      }
    })
  })
  it('stores multiple workspaces and remembers the selected workspace', async () => {
    const linear = await loadClientModule()

    await expect(linear.connect('token-alpha')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })
    await expect(linear.connect('token-beta')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-beta', organizationName: 'Beta' }
    })

    expect(linear.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'org-beta',
      workspaces: [
        { id: 'org-alpha', organizationName: 'Alpha' },
        { id: 'org-beta', organizationName: 'Beta' }
      ]
    })

    expect(linear.selectWorkspace('all')).toMatchObject({ selectedWorkspaceId: 'all' })

    linear.disconnect('org-alpha')
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      workspaces: [{ id: 'org-beta', organizationName: 'Beta' }]
    })
  })

  it('reports a legacy single-token workspace without constructing a Linear client', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule()

    expect(linear.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'legacy',
      workspaces: [{ id: 'legacy', organizationName: 'Alpha', isLegacy: true }]
    })
    expect(linearClientMock).not.toHaveBeenCalled()
  })

  // Fork-only (Pod): a Test only reads; upstream migrates the legacy token and selects the workspace.
  it('tests a legacy token without migrating it or moving the selection', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule()

    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })

    expect(linear.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'legacy',
      workspaces: [{ id: 'legacy', isLegacy: true }]
    })
    expect(existsSync(join(linearStoreDir(), 'linear-token.enc'))).toBe(true)
    expect(existsSync(join(linearStoreDir(), 'linear-workspaces.json'))).toBe(false)
  })

  // Fork-only (Pod): no plain-text fallback; upstream reads the token as plain text here.
  it('refuses a plaintext token that safeStorage cannot decrypt', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('not encrypted')
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
  })

  it('does not pass encrypted safeStorage bytes to the Linear SDK when encryption is unavailable', async () => {
    const tokenPath = join(linearStoreDir(), 'linear-token.enc')
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({ encryptionAvailable: false })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.',
      workspaces: [{ id: 'legacy' }]
    })
  })

  it('does not clear the Linear token when safeStorage decryption fails', async () => {
    const tokenPath = join(linearStoreDir(), 'linear-token.enc')
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(existsSync(tokenPath)).toBe(true)
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      credentialError:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.',
      workspaces: [{ id: 'legacy' }]
    })
  })

  it('clears the recorded credential error after Keychain access is approved', async () => {
    let keychainApproved = false
    writeLegacyLinearToken(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        if (!keychainApproved) {
          throw new Error('userCanceledErr')
        }
        return 'token-alpha'
      }
    })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error:
        'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    })
    expect(linear.getStatus().credentialError).toContain('Could not decrypt')

    keychainApproved = true
    await expect(linear.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })
    expect(linear.getStatus().credentialError).toBeUndefined()
  })

  it('treats empty Linear token files as missing credentials', async () => {
    writeLegacyLinearToken(Buffer.alloc(0), {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linear = await loadClientModule({ encryptionAvailable: false })

    await expect(linear.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error: 'No API key stored.'
    })

    expect(linearClientMock).not.toHaveBeenCalled()
    expect(linear.getStatus()).toMatchObject({ connected: false })
  })

  it('keeps healthy workspaces under the "all" selection when one cannot be decrypted', async () => {
    writeMultiWorkspaceFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'all'
    )
    fixtures.set('token-good', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationId: 'good',
      organizationName: 'good',
      organizationUrlKey: 'good'
    })
    const linear = await loadClientModule({
      encryptionAvailable: true,
      // Fork-only (Pod): "token-good" unseals (Pod has no plain-text fallback);
      // the binary "bad" token throws CredentialDecryptionError.
      decryptString: (value) => {
        if (value.includes(0xff)) {
          throw new Error('userCanceledErr')
        }
        return value.toString('utf-8')
      }
    })

    const clients = linear.getClients('all')
    expect(clients.map((client) => client.workspace.id)).toEqual(['good'])
    expect(linear.getStatus().credentialError).toContain('Could not decrypt')
  })

  it('rethrows the decrypt error for a specific workspace selection', async () => {
    writeMultiWorkspaceFiles(
      [
        { id: 'good', token: 'token-good' },
        { id: 'bad', token: Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]) }
      ],
      'bad'
    )
    const linear = await loadClientModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })

    expect(() => linear.getClients('bad')).toThrow('Could not decrypt')
  })
})
