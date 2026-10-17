// Fork-only (Pod): the .app a finished build left, found through the recipe's `build.output`
// (relative to the app's folder; segments may hold `*` and `?`). Only one made by this build counts:
// an .app older than its start is a previous build's, and two new ones are ambiguous. Its age is its
// Info.plist's or its executable's, which every build writes: an incremental build rewrites the
// files of the .app it made before, and the folder keeps that build's time.
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

function regexOf(segment: string): RegExp {
  const body = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

/** Existing paths under `dir` matching a relative pattern. */
export async function simGlob(dir: string, pattern: string): Promise<string[]> {
  let found = [dir]
  for (const segment of pattern.split('/').filter((part) => part !== '' && part !== '.')) {
    const next: string[] = []
    for (const base of found) {
      if (!/[*?]/.test(segment)) {
        next.push(join(base, segment))
        continue
      }
      const match = regexOf(segment)
      for (const entry of await readdir(base).catch(() => [])) {
        if (match.test(entry)) {
          next.push(join(base, entry))
        }
      }
    }
    found = next
  }
  const present = await Promise.all(
    found.map((path) =>
      stat(path).then(
        () => path,
        () => null
      )
    )
  )
  return present.filter((path): path is string => path !== null)
}

/** When the build last wrote the .app: its Info.plist or its executable, the later; null for neither. */
async function writtenAt(app: string): Promise<number | null> {
  const times = await Promise.all(
    [join(app, 'Info.plist'), join(app, basename(app, '.app'))].map((path) =>
      stat(path).then(
        (info) => info.mtimeMs,
        () => null
      )
    )
  )
  const known = times.filter((time): time is number => time !== null)
  return known.length > 0 ? Math.max(...known) : null
}

/** The one .app the build made, or why there is none to take. */
export async function simBuildOutput(
  build: Readonly<{ appDir: string; output: string; startedAt: number }>
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const fresh: string[] = []
  for (const path of (await simGlob(build.appDir, build.output)).filter((match) =>
    match.endsWith('.app')
  )) {
    const at = await writtenAt(path)
    if (at !== null && at >= build.startedAt - 1_000) {
      fresh.push(path)
    }
  }
  if (fresh.length === 1) {
    return { ok: true, path: fresh[0] }
  }
  return {
    ok: false,
    message: `the build exited 0 but left ${fresh.length === 0 ? 'no new' : `${fresh.length} new`} .app at ${build.output} in ${build.appDir}`
  }
}
