// Fork-only (Pod): the Mac-wide dev-client cache, one client per bundle id and native fingerprint,
// shared by every worktree and runtime (sim-app-paths.ts has the layout). A client lands whole or
// not at all: it is copied to a temp name beside its place and renamed in, so a reader that finds
// `<fingerprint>.app` finds all of it, and two runtimes landing the same client keep the first.
//
// Adopting another tool's cache (the recipe's `clientCache`, Portivo's portivo-mobile clients) is a
// copy through APFS clonefile (`cp -c`): a 418 MB, 939-file client lands in about 0.3 s and takes no
// space until either side changes, and Pod's copy stays when that tool prunes its own (portivo-mobile
// keeps two per app). A link would break on that prune. The other cache is only ever read.
//
// The cache's only evictor is here: past SIM_CLIENT_CACHE_BUDGET_BYTES it deletes the least recently
// used clients, never one used in the last day, one a caller protects (a live lease's), or the
// newest of a bundle id.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { simRunFailure, type SimRun } from '../adapters/sim-command-run'
import { simClientDir, simClientIn, type SimAppHome } from './sim-app-paths'

export const SIM_CLIENT_CACHE_BUDGET_BYTES = 8 * 1024 ** 3
export const SIM_CLIENT_KEEP_MS = 24 * 60 * 60_000
const COPY_TIMEOUT_MS = 10 * 60_000

const SimClientMeta = z.object({
  bundleId: z.string(),
  fingerprint: z.string(),
  bytes: z.number().nonnegative(),
  // `external:<dir>` or `build:<buildId>`.
  source: z.string(),
  landedAt: z.number(),
  lastUsedAt: z.number()
})
export type SimClientMeta = z.infer<typeof SimClientMeta>

export type SimClientLanding =
  | Readonly<{ ok: true; path: string; ms: number }>
  | Readonly<{ ok: false; message: string }>

export type SimClientCache = {
  /** Pod's client for this fingerprint, or null. */
  find(bundleId: string, fingerprint: string): Promise<string | null>
  /** Copies `<dir>/<fingerprint>.app` in; null when that cache has none. */
  adoptExternal(
    dir: string,
    bundleId: string,
    fingerprint: string
  ): Promise<SimClientLanding | null>
  /** Copies a build's .app in. */
  land(
    appPath: string,
    bundleId: string,
    fingerprint: string,
    source: string
  ): Promise<SimClientLanding>
  touch(bundleId: string, fingerprint: string): Promise<void>
  /** Deletes old clients past the budget; returns their paths. */
  evict(protect: ReadonlySet<string>): Promise<string[]>
}

export type SimClientCacheOptions = Readonly<{
  home: SimAppHome
  run: SimRun
  now?: () => number
  budgetBytes?: number
  // `~` in a recipe's clientCache.
  userHome: string
}>

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function bytesUnder(path: string): Promise<number> {
  const info = await stat(path).catch(() => null)
  if (!info) {
    return 0
  }
  if (!info.isDirectory()) {
    return info.size
  }
  let total = 0
  for (const entry of await readdir(path).catch(() => [])) {
    total += await bytesUnder(join(path, entry))
  }
  return total
}

export function createSimClientCache(options: SimClientCacheOptions): SimClientCache {
  const { home, run } = options
  const now = options.now ?? Date.now
  const budget = options.budgetBytes ?? SIM_CLIENT_CACHE_BUDGET_BYTES
  const expand = (dir: string) =>
    dir === '~' || dir.startsWith('~/') ? join(options.userHome, dir.slice(1)) : dir

  const metaPath = (app: string) => app.replace(/\.app$/, '.json')

  const readMeta = async (path: string): Promise<SimClientMeta | null> => {
    try {
      const parsed = SimClientMeta.safeParse(JSON.parse(await readFile(path, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** The bundle id an .app declares, through plutil (simulator builds write binary plists). */
  const bundleIdOf = async (app: string): Promise<string | null> => {
    const result = await run(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Info.plist')],
      { timeoutMs: 10_000 }
    )
    return result.ok && result.code === 0 ? result.stdout.trim() : null
  }

  const land = async (
    from: string,
    bundleId: string,
    fingerprint: string,
    source: string
  ): Promise<SimClientLanding> => {
    const started = performance.now()
    const dir = simClientDir(home, bundleId)
    const dest = simClientIn(dir ?? '', bundleId, fingerprint)
    if (!dir || !dest) {
      return { ok: false, message: `${bundleId} ${fingerprint} cannot name a client in the cache` }
    }
    if (await exists(dest)) {
      return { ok: true, path: dest, ms: performance.now() - started }
    }
    const declared = await bundleIdOf(from)
    if (declared !== bundleId) {
      return {
        ok: false,
        message: `${from} is ${declared ?? 'not an app with an Info.plist'}, not ${bundleId}`
      }
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temp = join(dir, `.${fingerprint}.${process.pid}.${Date.now()}.tmp.app`)
    const copied = await run('/bin/cp', ['-c', '-R', from, temp], { timeoutMs: COPY_TIMEOUT_MS })
    if (!copied.ok || copied.code !== 0) {
      await rm(temp, { recursive: true, force: true })
      return { ok: false, message: simRunFailure(`copying ${from} into the client cache`, copied) }
    }
    try {
      await rename(temp, dest)
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      // Another runtime landed it first.
      if (!(await exists(dest))) {
        return { ok: false, message: `the client cache refused ${dest}: ${String(error)}` }
      }
    }
    const at = now()
    const meta: SimClientMeta = {
      bundleId,
      fingerprint,
      bytes: await bytesUnder(dest),
      source,
      landedAt: at,
      lastUsedAt: at
    }
    await writeFile(metaPath(dest), JSON.stringify(meta), { mode: 0o600 }).catch(() => undefined)
    return { ok: true, path: dest, ms: performance.now() - started }
  }

  return {
    async find(bundleId, fingerprint) {
      const dir = simClientDir(home, bundleId)
      const path = dir ? simClientIn(dir, bundleId, fingerprint) : null
      return path && (await exists(join(path, 'Info.plist'))) ? path : null
    },

    async adoptExternal(dir, bundleId, fingerprint) {
      const from = simClientIn(expand(dir), bundleId, fingerprint)
      if (!from || !(await exists(join(from, 'Info.plist')))) {
        return null
      }
      return land(from, bundleId, fingerprint, `external:${dir}`)
    },

    land: (appPath, bundleId, fingerprint, source) => land(appPath, bundleId, fingerprint, source),

    async touch(bundleId, fingerprint) {
      const dir = simClientDir(home, bundleId)
      const path = dir ? simClientIn(dir, bundleId, fingerprint) : null
      if (!path) {
        return
      }
      const meta = await readMeta(metaPath(path))
      const next: SimClientMeta = meta
        ? { ...meta, lastUsedAt: now() }
        : {
            bundleId,
            fingerprint,
            bytes: await bytesUnder(path),
            source: 'unknown',
            landedAt: now(),
            lastUsedAt: now()
          }
      await writeFile(metaPath(path), JSON.stringify(next), { mode: 0o600 }).catch(() => undefined)
    },

    async evict(protect) {
      const clients: { path: string; meta: SimClientMeta }[] = []
      for (const bundleId of await readdir(home.clients).catch(() => [])) {
        const dir = join(home.clients, bundleId)
        for (const entry of await readdir(dir).catch(() => [])) {
          if (!entry.endsWith('.app') || entry.startsWith('.')) {
            continue
          }
          const path = join(dir, entry)
          const meta = (await readMeta(metaPath(path))) ?? {
            bundleId,
            fingerprint: entry.slice(0, -4),
            bytes: await bytesUnder(path),
            source: 'unknown',
            landedAt: 0,
            lastUsedAt: 0
          }
          clients.push({ path, meta })
        }
      }
      let total = clients.reduce((sum, client) => sum + client.meta.bytes, 0)
      const newest = new Map<string, number>()
      for (const { meta } of clients) {
        newest.set(meta.bundleId, Math.max(newest.get(meta.bundleId) ?? 0, meta.lastUsedAt))
      }
      const at = now()
      const gone: string[] = []
      for (const { path, meta } of [...clients].sort(
        (a, b) => a.meta.lastUsedAt - b.meta.lastUsedAt
      )) {
        if (total <= budget) {
          break
        }
        const keep =
          protect.has(path) ||
          at - meta.lastUsedAt < SIM_CLIENT_KEEP_MS ||
          newest.get(meta.bundleId) === meta.lastUsedAt
        if (keep) {
          continue
        }
        await rm(path, { recursive: true, force: true })
        await rm(metaPath(path), { force: true })
        total -= meta.bytes
        gone.push(path)
      }
      return gone
    }
  }
}
