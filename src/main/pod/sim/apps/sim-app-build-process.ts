// Fork-only (Pod): a dev-client build's process. It runs detached (it survives the runtime that
// started it, as portivo-mobile's did), through `claude-acc run --` when claude-acc is installed so
// its memory scheduler admits it like any native build, with the recipe's command in the app's
// folder. A small shell wrapper records the exit code in `<buildId>.status`, where every runtime
// can read it.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { SimBuildRecord } from './sim-app-build-records'
import type { SimDetachedSpawn, SimSpawned } from './sim-app-spawn'

// Runs the build, then records its exit code where every runtime can read it.
const WRAPPER =
  'status=$1; shift; "$@"; code=$?; printf "%s\\n" "$code" > "$status.tmp" && mv -f "$status.tmp" "$status"; exit "$code"'

export async function spawnSimBuildProcess(
  build: SimBuildRecord,
  options: Readonly<{
    logDir: string
    // claude-acc's executable, or null to run the command directly.
    claudeAcc: string | null
    env: NodeJS.ProcessEnv
    spawn: SimDetachedSpawn
    onExit: () => void
  }>
): Promise<SimSpawned> {
  await mkdir(options.logDir, { recursive: true, mode: 0o700 })
  await writeFile(
    build.logPath,
    `# Pod dev-client build ${build.buildId}: ${build.bundleId} ${build.fingerprint} in ${build.appDir}\n$ ${build.command}\n`,
    { mode: 0o600 }
  )
  const command = ['/bin/sh', '-c', build.command]
  const argv = options.claudeAcc
    ? [options.claudeAcc, 'run', '--agent', 'pod-sim', '--', ...command]
    : command
  return options.spawn({
    program: '/bin/sh',
    args: ['-c', WRAPPER, 'pod-sim-build', build.statusPath, ...argv],
    cwd: build.appDir,
    env: options.env,
    logPath: build.logPath,
    onExit: options.onExit
  })
}

/** The build's exit code; null when the file is unreadable, 'none' while it has none. */
export async function readSimBuildExit(statusPath: string): Promise<number | null | 'none'> {
  const text = await readFile(statusPath, 'utf8').catch(() => null)
  if (text === null) {
    return 'none'
  }
  const code = Number.parseInt(text.trim(), 10)
  return Number.isFinite(code) ? code : null
}
