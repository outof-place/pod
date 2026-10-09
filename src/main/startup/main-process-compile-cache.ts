import { constants, enableCompileCache } from 'node:module'

type EnableCompileCache = () => { status: number }

/** Turns on Node's on-disk V8 code cache for every CommonJS module compiled after this call. */
export function enableMainProcessCompileCache(
  enable: EnableCompileCache = enableCompileCache
): boolean {
  try {
    // Why no directory: Node then honors NODE_COMPILE_CACHE and NODE_DISABLE_COMPILE_CACHE, and
    // otherwise uses os.tmpdir(), keyed by Node version, V8 flags, file path and source hash.
    const { status } = enable()
    return (
      status === constants.compileCacheStatus.ENABLED ||
      status === constants.compileCacheStatus.ALREADY_ENABLED
    )
  } catch {
    // Why: a cache that cannot start must never block launch.
    return false
  }
}
