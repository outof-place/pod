// Fork-only (Pod): a terminal opened before the decouple update keeps only the ORCA_ spelling of
// its pane env, while the hook scripts the update installs read POD_. Each name a managed POSIX
// hook script reads takes its ORCA_ value while unset, and only in a Pod terminal: one whose
// endpoint lies in the data folder of the Pod that installed the script. An Orca.app terminal's
// points at Orca's server and token. A new terminal has the POD_ endpoint, so it pays nothing.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import { realpathSync } from 'node:fs'
import { legacyEnvName } from '../../../shared/pod-legacy-env-names'

/** This runtime's data folder, resolved: what an ORCA_ endpoint must lie in. The runtime's own
 *  env, set at its start; a terminal's env is the very thing in doubt. Null when it has none. */
export function bakedPodUserData(env: NodeJS.ProcessEnv = process.env): string | null {
  const userData = env.ORCA_USER_DATA_PATH
  if (!userData) {
    return null
  }
  try {
    return realpathSync(userData)
  } catch {
    return null
  }
}

// The pane env the scripts read; the codemod renames these with the rest.
const PANE_HOOK_ENV = [
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_NODE',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_PANE',
  'ORCA_AGENT_LAUNCH'
] as const

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export function buildPosixLegacyHookEnvLines(
  userData: string | null = bakedPodUserData()
): string[] {
  const lines = PANE_HOOK_ENV.flatMap((name: string) => {
    const legacy = legacyEnvName(name)
    // Before the codemod the names are the legacy ones already.
    return legacy === null
      ? []
      : [`    [ -n "\${${name}+x}" ] || [ -z "\${${legacy}+x}" ] || export ${name}="$${legacy}"`]
  })
  const [current] = PANE_HOOK_ENV
  const legacy = legacyEnvName(current)
  if (lines.length === 0 || legacy === null || userData === null) {
    return []
  }
  // The endpoint's folder, resolved, so a symlink can't lead out of it; a symlinked endpoint file
  // is refused. No message: a hook's output reaches the agent.
  return [
    `if [ -z "\${${current}+x}" ] && [ -n "\${${legacy}-}" ] && [ ! -L "$${legacy}" ]; then`,
    `  legacy_hook_dir=$(cd -P -- "\${${legacy}%/*}" 2>/dev/null && pwd -P) || legacy_hook_dir=`,
    '  case "$legacy_hook_dir/" in',
    `  ${shellQuote(`${userData}/`)}*)`,
    ...lines,
    '    ;;',
    '  esac',
    'fi'
  ]
}
