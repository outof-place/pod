// Fork-only (Pod): the Claude Code release a sandbox installs, cached once per Mac.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import type { MainHttpClient } from '../../network/http-client'
import { downloadVerifiedArchive } from '../../ssh/runtime-archive-download'

export const CLAUDE_RELEASES_URL = 'https://downloads.claude.ai/claude-code-releases'
const RELEASE_KEY_URL = 'https://downloads.claude.ai/keys/claude-code.asc'
/** From code.claude.com/docs/en/setup, "Binary integrity and code signing". */
export const CLAUDE_RELEASE_KEY_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE'
/** Earlier releases publish no manifest signature. */
const FIRST_SIGNED_RELEASE = [2, 1, 89]
const STALE_RELEASE_MS = 24 * 60 * 60_000
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** What the sandbox verifies and installs; the Mac only checks hashes, the VM checks the signature. */
export const SANDBOX_RELEASE_FILES = [
  'claude',
  'manifest.json',
  'manifest.json.sig',
  'release-key.gpg'
] as const

export type SandboxClaudeRelease = { version: string; platform: string; dir: string }

type Fetcher = MainHttpClient['fetch']

/** OrbStack runs machines at the Mac's own architecture. */
export function sandboxClaudePlatform(arch: string = process.arch): string {
  if (arch === 'arm64' || arch === 'x64') {
    return `linux-${arch}`
  }
  throw new Error(`OrbStack sandboxes do not support the ${arch} architecture.`)
}

export function isSignedClaudeRelease(version: string): boolean {
  const parts = version.split('.').map(Number)
  for (const [index, floor] of FIRST_SIGNED_RELEASE.entries()) {
    const part = parts[index] ?? 0
    if (part !== floor) {
      return part > floor
    }
  }
  return true
}

/** gpgv reads binary keyrings only, and a Mac may have no GnuPG to convert the published one. */
export function dearmorPublicKey(armored: string): Buffer {
  const lines = armored.split(/\r?\n/)
  const begin = lines.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----')
  const blank = lines.indexOf('', begin)
  const body: string[] = []
  for (const line of begin !== -1 && blank > begin ? lines.slice(blank + 1) : []) {
    if (line.startsWith('=') || line.startsWith('-----')) {
      break
    }
    body.push(line.trim())
  }
  const key = Buffer.from(body.join(''), 'base64')
  if (key.length === 0) {
    throw new Error('The Claude Code release key is not an armored public key.')
  }
  return key
}

/** The platform's checksum and size from a release manifest, refusing one for another version. */
export function readManifestEntry(
  manifestText: string,
  version: string,
  platform: string
): { checksum: string; size: number } {
  const manifest: unknown = JSON.parse(manifestText)
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : null
  const root = record(manifest)
  if (root?.version !== version) {
    throw new Error(`The Claude Code ${version} manifest names another version.`)
  }
  const entry = record(record(root.platforms)?.[platform])
  const checksum = entry?.checksum
  const size = entry?.size
  if (
    typeof checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    typeof size !== 'number'
  ) {
    throw new Error(`The Claude Code ${version} manifest has no ${platform} build.`)
  }
  return { checksum, size }
}

async function fetchBytes(fetcher: Fetcher, url: string): Promise<Buffer> {
  const response = await fetcher(url, { redirect: 'follow' })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function sha256File(path: string): Promise<string | null> {
  const hash = createHash('sha256')
  try {
    await pipeline(createReadStream(path), hash)
  } catch {
    return null
  }
  return hash.digest('hex')
}

export function createClaudeReleaseCache(deps: {
  /** One directory per version and platform; other versions are pruned after a day. */
  root: string
  fetcher: Fetcher
  platform: () => string
  now?: () => number
}) {
  const inFlight = new Map<string, Promise<SandboxClaudeRelease>>()

  const resolveVersion = async (hostVersion: string | null): Promise<string> => {
    const version =
      hostVersion ?? (await fetchBytes(deps.fetcher, `${CLAUDE_RELEASES_URL}/stable`)).toString()
    const trimmed = version.trim()
    if (!VERSION_PATTERN.test(trimmed)) {
      throw new Error(`Cannot install Claude Code version "${trimmed.slice(0, 40)}".`)
    }
    if (!isSignedClaudeRelease(trimmed)) {
      throw new Error(
        `Claude Code ${trimmed} predates signed releases. Update Claude Code on this Mac first.`
      )
    }
    return trimmed
  }

  const isCached = async (dir: string, version: string, platform: string): Promise<boolean> => {
    try {
      const manifest = await readFile(join(dir, 'manifest.json'), 'utf8')
      const { checksum } = readManifestEntry(manifest, version, platform)
      await Promise.all(SANDBOX_RELEASE_FILES.map((file) => stat(join(dir, file))))
      return (await sha256File(join(dir, 'claude'))) === checksum
    } catch {
      return false
    }
  }

  const fill = async (dir: string, version: string, platform: string): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const base = `${CLAUDE_RELEASES_URL}/${version}`
    const [manifest, signature, zstManifest, armoredKey] = await Promise.all([
      fetchBytes(deps.fetcher, `${base}/manifest.json`),
      fetchBytes(deps.fetcher, `${base}/manifest.json.sig`),
      fetchBytes(deps.fetcher, `${base}/manifest.zst.json`),
      fetchBytes(deps.fetcher, RELEASE_KEY_URL)
    ])
    const { checksum, size } = readManifestEntry(manifest.toString(), version, platform)
    const zst = readManifestEntry(zstManifest.toString(), version, platform)
    // Why the zstd build: a third of the download, and Node decompresses it without extra tools.
    const compressed = join(dir, 'claude.zst')
    await downloadVerifiedArchive(
      { label: 'Claude Code', url: `${base}/${platform}/claude.zst`, archiveSha256: zst.checksum },
      compressed,
      deps.fetcher
    )
    const partial = join(dir, 'claude.partial')
    const hash = createHash('sha256')
    let written = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length
        hash.update(chunk)
        callback(
          written > size ? new Error('Claude Code is larger than its manifest says.') : null,
          chunk
        )
      }
    })
    await pipeline(
      createReadStream(compressed),
      createZstdDecompress(),
      meter,
      createWriteStream(partial)
    )
    if (written !== size || hash.digest('hex') !== checksum) {
      throw new Error(`Claude Code ${version} does not match its release manifest.`)
    }
    await rename(partial, join(dir, 'claude'))
    await rm(compressed, { force: true })
    await writeFile(join(dir, 'manifest.json'), manifest)
    await writeFile(join(dir, 'manifest.json.sig'), signature)
    await writeFile(join(dir, 'release-key.gpg'), dearmorPublicKey(armoredKey.toString()))
  }

  const prune = async (keep: string): Promise<void> => {
    const now = (deps.now ?? Date.now)()
    for (const name of await readdir(deps.root).catch(() => [])) {
      const path = join(deps.root, name)
      if (name !== keep && now - (await stat(path)).mtimeMs > STALE_RELEASE_MS) {
        await rm(path, { recursive: true, force: true })
      }
    }
  }

  const prepareOnce = async (version: string, platform: string): Promise<SandboxClaudeRelease> => {
    const dir = join(deps.root, version, platform)
    if (!(await isCached(dir, version, platform))) {
      try {
        await fill(dir, version, platform)
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw error
      }
    }
    await prune(version).catch(() => undefined)
    return { version, platform, dir }
  }

  /** The verified-by-hash release for the Mac's Claude version, or the stable channel without one. */
  const prepare = async (hostVersion: string | null): Promise<SandboxClaudeRelease> => {
    const version = await resolveVersion(hostVersion)
    const platform = deps.platform()
    const key = `${version}/${platform}`
    const pending = inFlight.get(key) ?? prepareOnce(version, platform)
    inFlight.set(key, pending)
    try {
      return await pending
    } finally {
      inFlight.delete(key)
    }
  }

  return { prepare }
}

export type ClaudeReleaseCache = ReturnType<typeof createClaudeReleaseCache>
