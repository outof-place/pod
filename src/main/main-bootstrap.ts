import { createRequire, flushCompileCache } from 'node:module'
import { join } from 'node:path'
import { enableMainProcessCompileCache } from './startup/main-process-compile-cache'

// Why: past the launch burst, so a cold write (~50 ms once per app update) never delays the first window.
const COMPILE_CACHE_FLUSH_DELAY_MS = 10_000

// Why a separate entry: the compile cache only covers code compiled after it is enabled, and
// electron-vite emits the whole main process as one index.js bundle.
const compileCacheEnabled = enableMainProcessCompileCache()
createRequire(__filename)(join(__dirname, 'index.js'))
if (compileCacheEnabled) {
  // Why: Node otherwise writes the cache only at exit, which a crash or kill skips.
  setTimeout(flushCompileCache, COMPILE_CACHE_FLUSH_DELAY_MS).unref()
}
