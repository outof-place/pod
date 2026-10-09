import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

function mtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/** Build the macOS process-info addon for `pnpm dev` when it is missing or older than its source. */
export function prepareDevProcInfoAddon(repoRoot) {
  const addonDir = path.join(repoRoot, 'native', 'proc-info-darwin')
  const addon = path.join(addonDir, '.build', 'release', 'orca-proc-info.node')
  if (
    process.platform !== 'darwin' ||
    mtimeMs(addon) >= mtimeMs(path.join(addonDir, 'src', 'proc_info.c'))
  ) {
    return
  }
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'config', 'scripts', 'build-proc-info-macos.mjs'), '--single-arch'],
      { stdio: 'inherit' }
    )
  } catch (error) {
    // Why non-fatal: without clang the app keeps forking `ps`/`lsof`, which is only slower.
    console.warn(
      `[orca-dev] process-info addon build failed (ps/lsof stay in use): ${error?.message ?? error}`
    )
  }
}
