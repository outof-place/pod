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
import { hookRunContent } from '../shared/orca-yaml-run-content'
import { FOREIGN_BASE_SETUP_SKIPPED } from '../shared/automation-setup-trust'

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
  return { contentHash: sha256(scriptContent), scriptContent }
}

/** What the gate reads of a create: its approved hash, and whether an automation's run made it. */
export type SetupTrustCreate = {
  setupTrustHash?: string
  automationProvenance?: unknown
  automationProvenanceRequest?: unknown
}

export type SetupTrustStore = {
  getRepos(): Repo[]
  getUI?: () => { trustedOrcaHooks?: PersistedTrustedOrcaHooks }
}

/** Everything a create would start in the new worktree (`hookRunContent`), and its hash. */
export function setupRunTrust(
  repo: Repo,
  yamlHooks: OrcaHooks | null
): OrcaYamlSetupTrust | undefined {
  const scriptContent = hookRunContent('setup', repo.hookSettings, yamlHooks)
  return scriptContent ? { contentHash: sha256(scriptContent), scriptContent } : undefined
}

/** What a removal's archive run would start (the repo's own script included), and its hash. */
export function archiveRunTrust(
  repo: Repo,
  yamlHooks: OrcaHooks | null
): OrcaYamlSetupTrust | undefined {
  const scriptContent = hookRunContent('archive', repo.hookSettings, yamlHooks)
  return scriptContent ? { contentHash: sha256(scriptContent), scriptContent } : undefined
}

/**
 * Null when the create may run the new worktree's setup. Anything is allowed by the hash approved
 * for this create (`setupTrustHash`) of everything it would start. Someone else's code (`isForeign`)
 * needs exactly that, the repo's own script included, since in that checkout `make clean` runs the
 * other branch's Makefile. The repo's own code needs trust only for orca.yaml's shared commands:
 * their approved hash, the one recorded for the repo, or repo-wide trust while its id is unique
 * (the clients' rule). Otherwise what still needs trust; a store without UI state trusts nothing
 * but an approved hash. An automation's run from someone else's code never runs
 * setup, whatever hash it carries: no one is there to approve that run.
 */
export async function untrustedCreateSetup(
  store: SetupTrustStore,
  repo: Repo,
  yamlHooks: OrcaHooks | null,
  create: SetupTrustCreate,
  isForeign: () => Promise<boolean>
): Promise<NonNullable<CreateWorktreeResult['setupTrust']> | null> {
  const approvedHash = create.setupTrustHash
  const automation = Boolean(create.automationProvenance ?? create.automationProvenanceRequest)
  const run = setupRunTrust(repo, yamlHooks)
  if (run && automation && (await isForeign())) {
    return {
      status: 'needs-trust',
      contentHash: run.contentHash,
      reason: 'automation-foreign-base'
    }
  }
  if (!run || run.contentHash === approvedHash) {
    return null
  }
  if (await isForeign()) {
    return { status: 'needs-trust', contentHash: run.contentHash }
  }
  const trust = orcaYamlSetupTrust(repo, yamlHooks)
  if (!trust || trust.contentHash === approvedHash) {
    return null
  }
  const record = store.getUI?.().trustedOrcaHooks?.[repo.id]
  const uniqueId = store.getRepos().filter((other) => other.id === repo.id).length <= 1
  if (record?.setup?.contentHash === trust.contentHash || (record?.all && uniqueId)) {
    return null
  }
  return { status: 'needs-trust', contentHash: trust.contentHash }
}

/**
 * Pod: whether a removal that asked for hooks may run the archive script of a worktree made from
 * someone else's code (`foreignOrigin`): only with the hash approved for this removal of the
 * script that would run there, the repo's own included. Repo-wide and recorded trust don't count,
 * and an agent's `--run-hooks` is no approval. Null when allowed; otherwise the refusal.
 */
export function untrustedRemovalArchive(
  foreignOrigin: boolean | undefined,
  archiveScript: string | undefined,
  approvedHash: string | undefined,
  worktreePath: string
): Error | null {
  const script = archiveScript?.trim()
  if (!foreignOrigin || !script || sha256(script) === approvedHash) {
    return null
  }
  return new Error(
    `orca.yaml archive hook not run for ${worktreePath}: this worktree holds someone else's code, so its archive script needs approval for this removal. Remove it from Pod, which asks, or without --run-hooks.`
  )
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Default tabs still open, without their commands, while the setup they share needs trust. */
export function withoutTabCommands(
  defaultTabs: WorktreeDefaultTabsLaunch | undefined
): WorktreeDefaultTabsLaunch | undefined {
  return defaultTabs ? { ...defaultTabs, runCommands: false } : undefined
}

export function needsTrustWarning(
  worktreePath: string,
  setupTrust?: CreateWorktreeResult['setupTrust']
): string {
  if (setupTrust?.reason === 'automation-foreign-base') {
    return `${FOREIGN_BASE_SETUP_SKIPPED} (${worktreePath}). An automation never runs setup from someone else's code; run it yourself in the worktree.`
  }
  return `orca.yaml setup skipped for ${worktreePath}: its content isn't trusted yet. Pod asks about it on the next create, or run the setup yourself in the worktree.`
}
