// Fork-only (Pod): ORCA_ env names stay canonical in 1.0 (every byte shared with Orca reads them);
// Pod terminals also carry each renamed one as POD_. The full rename comes with the ~/.pod move.
import { POD_RENAMED_ORCA_ENV_NAMES } from './pod-env-alias-names'

const ORCA_PREFIX = 'ORCA_'
const POD_PREFIX = 'POD_'

/** Renamed names (by suffix) that never get a POD_ alias. */
export const POD_ENV_ALIAS_EXCLUSIONS: Readonly<Record<string, string>> = {
  HISTFILE: 'the shell wrapper consumes and unsets it',
  ORIG_ZDOTDIR: 'the shell wrapper consumes and unsets it',
  SHELL_FEATURES: 'the shell wrapper consumes and unsets it',
  CLAUDE_INJECTED_CONFIG_DIR: 'the shell wrapper consumes and unsets it',
  VERSION: 'POD_VERSION is the app version (electron-builder.pod.cjs)',
  ATTRIBUTION_BYPASS: 'the legacy-terminal tombstone unsets it',
  ATTRIBUTION_SHIM_DIR: 'the legacy-terminal tombstone unsets it',
  ENABLE_GIT_ATTRIBUTION: 'the legacy-terminal tombstone unsets it',
  GH_ISSUE_FOOTER: 'the legacy-terminal tombstone unsets it',
  GH_PR_FOOTER: 'the legacy-terminal tombstone unsets it',
  GIT_COMMIT_TRAILER: 'the legacy-terminal tombstone unsets it',
  AGENT_HOOK_TRANSPORT: 'the legacy-terminal tombstone unsets it',
  SSH_BRIDGE_CREDENTIAL: 'a per-invocation credential: no second copy in env'
}

export const POD_ALIASED_ORCA_ENV_NAMES: readonly string[] = POD_RENAMED_ORCA_ENV_NAMES.filter(
  (name) => !Object.hasOwn(POD_ENV_ALIAS_EXCLUSIONS, name.slice(ORCA_PREFIX.length))
)

/**
 * Settings a user sets for the app (tokens, switches, tool paths); their POD_ spelling wins.
 * Never terminal-scoped names, the per-profile CLI install path, or the stripped attribution names.
 */
export const POD_USER_SETTABLE_ORCA_ENV_NAMES: readonly string[] = [
  'ORCA_AZURE_DEVOPS_ACCESS_TOKEN',
  'ORCA_AZURE_DEVOPS_API_BASE_URL',
  'ORCA_AZURE_DEVOPS_PAT',
  'ORCA_AZURE_DEVOPS_TOKEN',
  'ORCA_AZURE_DEVOPS_USERNAME',
  'ORCA_BITBUCKET_ACCESS_TOKEN',
  'ORCA_BITBUCKET_API_BASE_URL',
  'ORCA_BITBUCKET_API_TOKEN',
  'ORCA_BITBUCKET_EMAIL',
  'ORCA_BROWSER_EXECUTABLE',
  'ORCA_DIAGNOSTICS_DISABLED',
  'ORCA_DISABLE_AGENT_BROWSER_SWEEP',
  'ORCA_DISABLE_CODEX_TRUST_RPC',
  'ORCA_DISABLE_HTTP2',
  'ORCA_DISABLE_MACOS_LOGIN_SHELL',
  'ORCA_DISABLE_NATIVE_PROCESS_INFO',
  'ORCA_DISABLE_REPO_REF_MAINTENANCE',
  'ORCA_GH_EXEC_TIMEOUT_MS',
  'ORCA_GITEA_API_BASE_URL',
  'ORCA_GITEA_TOKEN',
  'ORCA_GIT_ADMISSION_DISABLED',
  'ORCA_REQUIRE_FISH',
  'ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS',
  'ORCA_SSH_FORCE_SYSTEM_TRANSPORT',
  'ORCA_SYSTEM_SFTP_PATH',
  'ORCA_SYSTEM_SSH_PATH',
  'ORCA_TELEMETRY_DISABLED',
  'ORCA_WORKTREE_ADD_TIMEOUT_MS'
]

/**
 * - 'final': the env right before a spawn: user POD_ settings win, then POD_ = ORCA_ for every
 *   aliased name, and a POD_ without its ORCA_ goes.
 * - 'request': a spawn request, which a daemon from before the aliases may serve: user settings
 *   only, so that daemon never splits a value.
 * - 'start': the app's own process.env, once: user settings, and inherited POD_ twins of every
 *   other aliased name go, so no non-terminal child inherits a stale one.
 */
export type PodEnvAliasMode = 'final' | 'request' | 'start'

/** Mode 'request' on a spawn request that carries env. */
export function applyPodEnvAliasesToRequest(request: {
  env?: Record<string, string>
  envToDelete?: string[]
}): void {
  if (request.env) {
    applyPodEnvAliases(request.env, { mode: 'request', envToDelete: request.envToDelete })
  }
}

export function podSpellingOf(orcaName: string): string {
  return `${POD_PREFIX}${orcaName.slice(ORCA_PREFIX.length)}`
}

/** In place and idempotent. Returns the user settings taken from POD_ (names, never values). */
export function applyPodEnvAliases(
  env: Record<string, string | undefined>,
  options: { mode?: PodEnvAliasMode; envToDelete?: string[] } = {}
): string[] {
  const mode = options.mode ?? 'final'
  const deleted = new Set(options.envToDelete ?? [])
  const mirrorDeletion = (orcaName: string): void => {
    const podName = podSpellingOf(orcaName)
    if (deleted.has(orcaName) && !deleted.has(podName)) {
      options.envToDelete?.push(podName)
      deleted.add(podName)
    }
  }
  const adopted: string[] = []
  for (const name of POD_USER_SETTABLE_ORCA_ENV_NAMES) {
    if (deleted.has(name)) {
      // Why: the provider drops the ORCA_ spelling, so the POD_ one goes with it.
      mirrorDeletion(name)
      continue
    }
    const value = env[podSpellingOf(name)]
    if (value !== undefined && env[name] !== value) {
      env[name] = value
      adopted.push(name)
    }
  }
  if (mode === 'request') {
    POD_ALIASED_ORCA_ENV_NAMES.forEach(mirrorDeletion)
    return adopted
  }
  const userSettable = new Set(POD_USER_SETTABLE_ORCA_ENV_NAMES)
  for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
    const podName = podSpellingOf(name)
    if (mode === 'start') {
      if (!userSettable.has(name)) {
        delete env[podName]
      }
      continue
    }
    const value = env[name]
    if (value === undefined) {
      delete env[podName]
    } else {
      env[podName] = value
    }
  }
  return adopted
}
