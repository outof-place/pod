import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../durable-file-write'

// Why: per-source records are most of a usage cache (43 of 56 MB on one real Claude history) and
// only a scan reads them, so they live in this worker-owned sidecar and never touch main.

/** Where one provider's per-source scan cache lives, and whether this scan may start from it. */
export type UsageSourceCacheRef = {
  path: string
  schemaVersion: number
  reuse: boolean
}

export type UsageCacheSplitRequest = { cacheFile: string; sourceKey: string }
export type UsageCacheSplitResult = { reportText: string | null; migrated: boolean }

export function usageSourceCachePath(cacheFile: string): string {
  const { dir, name } = parse(cacheFile)
  return join(dir, `${name}-sources.json`)
}

/** The last scan's records; none when unreadable or from another schema, so the scan starts cold. */
export async function readUsageSourceCache<T>(ref: UsageSourceCacheRef): Promise<T[]> {
  if (!ref.reuse) {
    return []
  }
  try {
    const parsed = JSON.parse(await readFile(ref.path, 'utf-8'))
    return parsed?.schemaVersion === ref.schemaVersion && Array.isArray(parsed.sources)
      ? parsed.sources
      : []
  } catch {
    return []
  }
}

export async function writeUsageSourceCache(
  ref: UsageSourceCacheRef,
  sources: readonly unknown[]
): Promise<void> {
  await mkdir(dirname(ref.path), { recursive: true }).catch(() => {})
  // Why: a worker terminated mid-write orphans a multi-MB temp file; reclaim earlier launches' ones.
  await removeStaleDurableWriteTempFiles(ref.path)
  await writeFileDurable(
    durableWriteTempPath(ref.path),
    ref.path,
    JSON.stringify({ schemaVersion: ref.schemaVersion, sources })
  )
}

/**
 * Caches written before the sidecar existed carry the per-source records inline. Move them into
 * the sidecar and hand back only the report, so main parses a few MB instead of the whole file.
 */
export async function splitUsageCacheFile(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  let text: string
  try {
    text = await readFile(request.cacheFile, 'utf-8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { reportText: null, migrated: false }
    }
    throw error
  }
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed[request.sourceKey])) {
    return { reportText: text, migrated: false }
  }
  const { [request.sourceKey]: sources, ...report } = parsed
  await writeUsageSourceCache(
    {
      path: usageSourceCachePath(request.cacheFile),
      schemaVersion: report.schemaVersion,
      reuse: true
    },
    sources
  )
  return { reportText: JSON.stringify(report), migrated: true }
}
