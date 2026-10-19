import { fileURLToPath } from 'node:url'

const HIDDEN_DOCK_PRELOAD = fileURLToPath(
  new URL('./electron-probe-hidden-dock-preload.cjs', import.meta.url)
)

// Why: a plain Electron launch on macOS gets a Dock tile, and a unit run starts a dozen probes.
// Apply this to the env of every test-spawned Electron main process; ELECTRON_RUN_AS_NODE runs
// never show a tile and do not need it.
export function withHiddenDockProbeEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform !== 'darwin') {
    return env
  }
  const preload = `--require ${JSON.stringify(HIDDEN_DOCK_PRELOAD)}`
  return { ...env, NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload }
}
