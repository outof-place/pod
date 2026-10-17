import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { RunProcess } from './pod-gocache-helper-binary'

// `go env` reads a few files; a cold first exec after an update may wait on the malware scan.
const GO_ENV_TIMEOUT_MS = 15_000

export type UserGoCache = { cacheDir: string } | { skip: 'no-go-toolchain' | 'gocache-off' }

/** The login shell's PATH entries first, then the rest of `current`, as a terminal would see it. */
export function loginShellPath(segments: readonly string[], current: string | undefined): string {
  const first = new Set(segments)
  return [...segments, ...(current ?? '').split(delimiter).filter((s) => s && !first.has(s))].join(
    delimiter
  )
}

function findExecutable(name: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) {
      continue
    }
    const candidate = join(dir, name)
    try {
      const stat = statSync(candidate, { throwIfNoEntry: false })
      if (stat?.isFile() && (stat.mode & 0o111) !== 0) {
        return candidate
      }
    } catch {
      // unreadable PATH entry
    }
  }
  return null
}

/** The user's GOCACHE as their own go reports it (`go env -w` included), from `env`'s PATH. */
export async function resolveUserGoCache(
  env: NodeJS.ProcessEnv,
  run: RunProcess
): Promise<UserGoCache> {
  const go = findExecutable('go', env.PATH)
  if (!go) {
    return { skip: 'no-go-toolchain' }
  }
  let result
  try {
    result = await run({
      program: go,
      args: ['env', 'GOCACHE'],
      // local: a GOTOOLCHAIN or go.mod naming a newer go must not download one just to answer this
      env: { ...env, GOTOOLCHAIN: 'local', GOFLAGS: '' },
      cwd: '/',
      timeoutMs: GO_ENV_TIMEOUT_MS
    })
  } catch {
    return { skip: 'no-go-toolchain' }
  }
  if (result.code !== 0) {
    return { skip: 'no-go-toolchain' }
  }
  const cacheDir = result.stdout.trim()
  // go answers "off" for a disabled cache and for a relative GOCACHE it refuses
  return isAbsolute(cacheDir) ? { cacheDir } : { skip: 'gocache-off' }
}
