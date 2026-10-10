import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_RELEASES_URL,
  createClaudeReleaseCache,
  dearmorPublicKey,
  isSignedClaudeRelease,
  readManifestEntry,
  sandboxClaudePlatform
} from './pod-orbstack-claude-release'

const PLATFORM = 'linux-arm64'
const KEY = randomBytes(300)

function armor(bytes: Buffer): string {
  const body = bytes.toString('base64').match(/.{1,64}/g) ?? []
  return [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    'Comment: test',
    '',
    ...body,
    '=abcd',
    '-----END PGP PUBLIC KEY BLOCK-----',
    ''
  ].join('\n')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifest(version: string, bytes: Buffer): string {
  return JSON.stringify({
    version,
    platforms: { [PLATFORM]: { checksum: sha256(bytes), size: bytes.length } }
  })
}

function releaseServer(version: string, binary: Buffer, overrides: Record<string, Buffer> = {}) {
  const compressed = zstdCompressSync(binary)
  const base = `${CLAUDE_RELEASES_URL}/${version}`
  const files: Record<string, Buffer> = {
    [`${CLAUDE_RELEASES_URL}/stable`]: Buffer.from(`${version}\n`),
    [`${base}/manifest.json`]: Buffer.from(manifest(version, binary)),
    [`${base}/manifest.json.sig`]: Buffer.from('signature'),
    [`${base}/manifest.zst.json`]: Buffer.from(manifest(version, compressed)),
    [`${base}/${PLATFORM}/claude.zst`]: compressed,
    'https://downloads.claude.ai/keys/claude-code.asc': Buffer.from(armor(KEY)),
    ...overrides
  }
  const requests: string[] = []
  const fetcher = async (url: string): Promise<Response> => {
    requests.push(url)
    const body = files[url]
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
  }
  return { fetcher, requests }
}

const roots: string[] = []

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pod-claude-release-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('release facts', () => {
  it('maps the Mac architecture to the Linux build OrbStack runs', () => {
    expect(sandboxClaudePlatform('arm64')).toBe('linux-arm64')
    expect(sandboxClaudePlatform('x64')).toBe('linux-x64')
    expect(() => sandboxClaudePlatform('ia32')).toThrow('ia32')
  })

  it('knows which releases publish a signed manifest', () => {
    expect(isSignedClaudeRelease('2.1.89')).toBe(true)
    expect(isSignedClaudeRelease('2.1.295')).toBe(true)
    expect(isSignedClaudeRelease('3.0.0')).toBe(true)
    expect(isSignedClaudeRelease('2.1.88')).toBe(false)
    expect(isSignedClaudeRelease('1.9.999')).toBe(false)
  })

  it('dearmors the published key into the binary keyring gpgv reads', () => {
    expect(dearmorPublicKey(armor(KEY)).equals(KEY)).toBe(true)
    expect(dearmorPublicKey(armor(KEY).replaceAll('\n', '\r\n')).equals(KEY)).toBe(true)
    expect(() => dearmorPublicKey('<html>not found</html>')).toThrow('armored public key')
  })

  it('reads the platform entry only from the manifest of the pinned version', () => {
    const binary = Buffer.from('claude')
    expect(readManifestEntry(manifest('2.1.295', binary), '2.1.295', PLATFORM)).toEqual({
      checksum: sha256(binary),
      size: binary.length
    })
    expect(() => readManifestEntry(manifest('2.1.290', binary), '2.1.295', PLATFORM)).toThrow(
      'names another version'
    )
    expect(() => readManifestEntry(manifest('2.1.295', binary), '2.1.295', 'linux-x64')).toThrow(
      'no linux-x64 build'
    )
  })
})

describe('createClaudeReleaseCache', () => {
  it('downloads the zstd build once, checks it against the manifest and keeps it per version', async () => {
    const root = cacheRoot()
    const binary = randomBytes(4096)
    const { fetcher, requests } = releaseServer('2.1.295', binary)
    const cache = createClaudeReleaseCache({ root, fetcher, platform: () => PLATFORM })

    const release = await cache.prepare('2.1.295')
    expect(release).toEqual({
      version: '2.1.295',
      platform: PLATFORM,
      dir: join(root, '2.1.295', PLATFORM)
    })
    expect(readFileSync(join(release.dir, 'claude')).equals(binary)).toBe(true)
    expect(readFileSync(join(release.dir, 'release-key.gpg')).equals(KEY)).toBe(true)
    expect(readFileSync(join(release.dir, 'manifest.json.sig'), 'utf8')).toBe('signature')
    expect(existsSync(join(release.dir, 'claude.zst'))).toBe(false)
    expect(requests).not.toContain(`${CLAUDE_RELEASES_URL}/2.1.295/${PLATFORM}/claude`)

    const fetched = requests.length
    await cache.prepare('2.1.295')
    expect(requests).toHaveLength(fetched)

    writeFileSync(join(release.dir, 'claude'), 'tampered')
    await cache.prepare('2.1.295')
    expect(readFileSync(join(release.dir, 'claude')).equals(binary)).toBe(true)
  })

  it('shares one download between concurrent sandboxes', async () => {
    const { fetcher, requests } = releaseServer('2.1.295', randomBytes(2048))
    const cache = createClaudeReleaseCache({ root: cacheRoot(), fetcher, platform: () => PLATFORM })
    await Promise.all([cache.prepare('2.1.295'), cache.prepare('2.1.295')])
    expect(requests.filter((url) => url.endsWith('claude.zst'))).toHaveLength(1)
  })

  it('installs the stable channel when the Mac has no Claude Code', async () => {
    const { fetcher } = releaseServer('2.1.287', randomBytes(64))
    const cache = createClaudeReleaseCache({ root: cacheRoot(), fetcher, platform: () => PLATFORM })
    expect((await cache.prepare(null)).version).toBe('2.1.287')
  })

  it('refuses releases without a manifest signature', async () => {
    const { fetcher, requests } = releaseServer('2.1.80', randomBytes(64))
    const cache = createClaudeReleaseCache({ root: cacheRoot(), fetcher, platform: () => PLATFORM })
    await expect(cache.prepare('2.1.80')).rejects.toThrow('predates signed releases')
    expect(requests).toEqual([])
  })

  it('drops a download that does not match the manifest', async () => {
    const root = cacheRoot()
    const binary = randomBytes(1024)
    const other = zstdCompressSync(randomBytes(1024))
    const { fetcher } = releaseServer('2.1.295', binary, {
      [`${CLAUDE_RELEASES_URL}/2.1.295/${PLATFORM}/claude.zst`]: other,
      [`${CLAUDE_RELEASES_URL}/2.1.295/manifest.zst.json`]: Buffer.from(manifest('2.1.295', other))
    })
    const cache = createClaudeReleaseCache({ root, fetcher, platform: () => PLATFORM })
    await expect(cache.prepare('2.1.295')).rejects.toThrow('does not match its release manifest')
    expect(existsSync(join(root, '2.1.295'))).toBe(true)
    expect(existsSync(join(root, '2.1.295', PLATFORM))).toBe(false)
  })

  it('prunes other versions after a day, never the one it just prepared', async () => {
    const root = cacheRoot()
    const old = join(root, '2.1.200')
    const recent = join(root, '2.1.290')
    mkdirSync(old)
    mkdirSync(recent)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    utimesSync(old, twoDaysAgo, twoDaysAgo)
    const { fetcher } = releaseServer('2.1.295', randomBytes(64))
    const cache = createClaudeReleaseCache({ root, fetcher, platform: () => PLATFORM })
    await cache.prepare('2.1.295')
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(join(root, '2.1.295'))).toBe(true)
  })
})
