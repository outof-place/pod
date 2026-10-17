// Fork-only (Pod): orca.yaml setup trust, checked by the host itself before a create runs a setup.
// A create runs the NEW worktree's orca.yaml (its base branch's), which may differ from the root
// checkout's that a client asked about, or come from a fork's pull request. The content and hash
// are the clients' (setup script plus default tab commands, trimmed, sha256 hex), so a hash a
// client recorded in `trustedOrcaHooks` or sent with the create matches it.
import { createHash } from 'node:crypto'
import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import type { OrcaHooks, PersistedTrustedOrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { CreateWorktreeResult } from '../shared/worktree/create-types'
import type { WorktreeDefaultTabsLaunch } from '../shared/worktree/launch-types'
import { getDefaultTabCommandTrustContent } from './effective-hook-config'

export type OrcaYamlSetupTrust = { contentHash: string; scriptContent: string }

/** What a user must trust before this orca.yaml's shared commands run: none when none can run. */
export function orcaYamlSetupTrust(
  repo: Repo,
  yamlHooks: OrcaHooks | null
): OrcaYamlSetupTrust | undefined {
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo.hookSettings?.scripts.setup?.trim())
  })
  const scriptContent = getDefaultTabCommandTrustContent(yamlHooks).trim()
  if (!scriptContent || policy === 'local-only') {
    return undefined
  }
  return { contentHash: createHash('sha256').update(scriptContent).digest('hex'), scriptContent }
}

export type SetupTrustStore = {
  getRepos(): Repo[]
  getUI?: () => { trustedOrcaHooks?: PersistedTrustedOrcaHooks }
}

/**
 * Null when the create may run the new worktree's shared setup: its content is the one the user
 * approved for this create (`approvedHash`), or the one recorded for the repo, or the repo is
 * trusted whole while its id is unique (the clients' rule). The last two don't count for a create
 * from someone else's code (`isForeign`, asked only when they would decide). Otherwise what still
 * needs trust; a store without UI state trusts nothing but an approved hash.
 */
export async function untrustedCreateSetup(
  store: SetupTrustStore,
  repo: Repo,
  yamlHooks: OrcaHooks | null,
  approvedHash: string | undefined,
  isForeign: () => Promise<boolean>
): Promise<NonNullable<CreateWorktreeResult['setupTrust']> | null> {
  const trust = orcaYamlSetupTrust(repo, yamlHooks)
  if (!trust || trust.contentHash === approvedHash) {
    return null
  }
  const record = store.getUI?.().trustedOrcaHooks?.[repo.id]
  const uniqueId = store.getRepos().filter((other) => other.id === repo.id).length <= 1
  const recorded = record?.setup?.contentHash === trust.contentHash || (record?.all && uniqueId)
  if (recorded && !(await isForeign())) {
    return null
  }
  return { status: 'needs-trust', contentHash: trust.contentHash }
}

/** Default tabs still open, without their commands, while the setup they share needs trust. */
export function withoutTabCommands(
  defaultTabs: WorktreeDefaultTabsLaunch | undefined
): WorktreeDefaultTabsLaunch | undefined {
  return defaultTabs ? { ...defaultTabs, runCommands: false } : undefined
}

export function needsTrustWarning(worktreePath: string): string {
  return `orca.yaml setup skipped for ${worktreePath}: its content isn't trusted yet. Pod asks about it on the next create, or run the setup yourself in the worktree.`
}
