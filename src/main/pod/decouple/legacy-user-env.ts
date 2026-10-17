// Fork-only (Pod): for one release the app process takes a user's ORCA_ settings (tokens, switches,
// tool paths) when the POD_ spelling is unset: POD_ first, then ORCA_, as the simulators read them.
// Only names a user or a script sets for the app. Terminal-scoped names (pane identity, the hook
// endpoint, launch tokens) are Pod's own, and a parent terminal's must never pass for them.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import { renamedLegacyEnvName } from '../../../shared/pod-legacy-env-names'

export const LEGACY_USER_ENV_NAMES = [
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
  'ORCA_CLI_INSTALL_PATH',
  'ORCA_DIAGNOSTICS_DISABLED',
  'ORCA_DISABLE_AGENT_BROWSER_SWEEP',
  'ORCA_DISABLE_CODEX_TRUST_RPC',
  'ORCA_DISABLE_HTTP2',
  'ORCA_DISABLE_MACOS_LOGIN_SHELL',
  'ORCA_DISABLE_NATIVE_PROCESS_INFO',
  'ORCA_DISABLE_REPO_REF_MAINTENANCE',
  'ORCA_ENABLE_GIT_ATTRIBUTION',
  'ORCA_GH_EXEC_TIMEOUT_MS',
  'ORCA_GH_ISSUE_FOOTER',
  'ORCA_GH_PR_FOOTER',
  'ORCA_GITEA_API_BASE_URL',
  'ORCA_GITEA_TOKEN',
  'ORCA_GIT_ADMISSION_DISABLED',
  'ORCA_GIT_COMMIT_TRAILER',
  'ORCA_REQUIRE_FISH',
  'ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS',
  'ORCA_SSH_FORCE_SYSTEM_TRANSPORT',
  'ORCA_SYSTEM_SFTP_PATH',
  'ORCA_SYSTEM_SSH_PATH',
  'ORCA_TELEMETRY_DISABLED',
  'ORCA_WORKTREE_ADD_TIMEOUT_MS'
] as const

/** In place: each listed name the env leaves unset takes its ORCA_ value. Returns the names taken
 *  (never their values). Before the codemod the names have no other spelling and nothing changes. */
export function adoptLegacyUserEnv(env: NodeJS.ProcessEnv): string[] {
  const adopted: string[] = []
  for (const name of LEGACY_USER_ENV_NAMES) {
    const legacy = renamedLegacyEnvName(name)
    const value = legacy === null ? undefined : env[legacy]
    if (env[name] === undefined && value !== undefined) {
      env[name] = value
      adopted.push(name)
    }
  }
  return adopted
}
