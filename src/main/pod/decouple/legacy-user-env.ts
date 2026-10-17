// Fork-only (Pod): for one release the app process takes a user's ORCA_ settings (tokens, switches,
// tool paths) when the POD_ spelling is unset: POD_ first, then ORCA_, as the simulators read them.
// Only names a user or a script sets for the app. Terminal-scoped names (pane identity, the hook
// endpoint, launch tokens) are Pod's own, and a parent terminal's must never pass for them. The CLI
// install path stays out too: set for the legacy app, it names where that app's CLI lives.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import { renamedLegacyEnvName } from '../../../shared/pod-legacy-env-names'

export const LEGACY_USER_ENV_NAMES = [
  'POD_AZURE_DEVOPS_ACCESS_TOKEN',
  'POD_AZURE_DEVOPS_API_BASE_URL',
  'POD_AZURE_DEVOPS_PAT',
  'POD_AZURE_DEVOPS_TOKEN',
  'POD_AZURE_DEVOPS_USERNAME',
  'POD_BITBUCKET_ACCESS_TOKEN',
  'POD_BITBUCKET_API_BASE_URL',
  'POD_BITBUCKET_API_TOKEN',
  'POD_BITBUCKET_EMAIL',
  'POD_BROWSER_EXECUTABLE',
  'POD_DIAGNOSTICS_DISABLED',
  'POD_DISABLE_AGENT_BROWSER_SWEEP',
  'POD_DISABLE_CODEX_TRUST_RPC',
  'POD_DISABLE_HTTP2',
  'POD_DISABLE_MACOS_LOGIN_SHELL',
  'POD_DISABLE_NATIVE_PROCESS_INFO',
  'POD_DISABLE_REPO_REF_MAINTENANCE',
  'POD_ENABLE_GIT_ATTRIBUTION',
  'POD_GH_EXEC_TIMEOUT_MS',
  'POD_GH_ISSUE_FOOTER',
  'POD_GH_PR_FOOTER',
  'POD_GITEA_API_BASE_URL',
  'POD_GITEA_TOKEN',
  'POD_GIT_ADMISSION_DISABLED',
  'POD_GIT_COMMIT_TRAILER',
  'POD_REQUIRE_FISH',
  'POD_SKILL_PACKAGE_DOWNLOAD_ORIGINS',
  'POD_SSH_FORCE_SYSTEM_TRANSPORT',
  'POD_SYSTEM_SFTP_PATH',
  'POD_SYSTEM_SSH_PATH',
  'POD_TELEMETRY_DISABLED',
  'POD_WORKTREE_ADD_TIMEOUT_MS'
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
