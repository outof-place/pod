// Fork-only (Pod): a terminal opened before the decouple update keeps only the ORCA_ spelling of
// its pane env, while the hook scripts the update installs read POD_. Each name a managed POSIX
// hook script reads takes its ORCA_ value while unset; no fork, so a new terminal pays nothing.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.

const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep

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

export function buildPosixLegacyHookEnvLines(): string[] {
  return PANE_HOOK_ENV.flatMap((name: string) => {
    // Before the codemod the names are the legacy ones already.
    if (!name.startsWith(SPELLINGS.current)) {
      return []
    }
    const legacy = `${SPELLINGS.legacy}${name.slice(SPELLINGS.current.length)}`
    return [`[ -n "\${${name}+x}" ] || [ -z "\${${legacy}+x}" ] || export ${name}="$${legacy}"`]
  })
}
