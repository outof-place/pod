// Fork-only (Pod): where the pod-sim helper binary is. Packaging puts it in Contents/Resources/bin
// (stage 2b); a checkout builds it with native/pod-sim-macos/scripts/build.sh.
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SIM_HELPER_FILE_NAME = 'pod-sim'
/** Outside a packaged Pod, overrides every other candidate (probes and tests point it at a build). */
export const SIM_HELPER_BINARY_ENV = 'POD_SIM_HELPER_BINARY'
const DEV_BUILD = join('native', 'pod-sim-macos', '.build', 'release', SIM_HELPER_FILE_NAME)

export type SimHelperPathOptions = {
  /** `app.isPackaged`: a packaged Pod runs only the helper it ships, never an override or a checkout. */
  packaged: boolean
  env?: Readonly<Record<string, string | undefined>>
  resourcesPath?: string
  cwd?: string
  moduleDir?: string
  exists?: (path: string) => boolean
}

/** Candidates in order: the override, the app's resources, the checkout (cwd, then from out/main). */
export function simHelperCandidates(options: SimHelperPathOptions): string[] {
  const env = options.env ?? process.env
  // Electron's; the plain Node CLI has no resourcesPath.
  const appResources: unknown = Reflect.get(process, 'resourcesPath')
  const resourcesPath =
    'resourcesPath' in options
      ? options.resourcesPath
      : typeof appResources === 'string'
        ? appResources
        : undefined
  const bundled = resourcesPath ? join(resourcesPath, 'bin', SIM_HELPER_FILE_NAME) : undefined
  const candidates = options.packaged
    ? [bundled]
    : [
        env[SIM_HELPER_BINARY_ENV],
        bundled,
        join(options.cwd ?? process.cwd(), DEV_BUILD),
        resolve(options.moduleDir ?? __dirname, '..', '..', DEV_BUILD)
      ]
  return candidates.filter((path): path is string => typeof path === 'string' && path !== '')
}

export function resolveSimHelperBinary(options: SimHelperPathOptions): string | null {
  const exists = options.exists ?? existsSync
  return simHelperCandidates(options).find((path) => exists(path)) ?? null
}

/** Which build is at `path`: a rebuild or an app update changes it. Null when it cannot be read. */
export function simHelperBinaryStamp(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}
