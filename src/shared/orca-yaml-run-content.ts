// Fork-only (Pod): everything a hook would run in a checkout of someone else's code, where the
// repo's own scripts (`make clean`, `pnpm run setup`) run that branch's files too, so a run there
// needs this content approved, the user's own script included. Host and clients both hash it.
import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'
import type { OrcaHooks, RepoHookSettings } from './orca-yaml-hook-types'

/** The main process's `getEffectiveHookScript`: orca.yaml's, the repo's own, or both, per policy. */
function effectiveScript(
  hookSettings: RepoHookSettings | undefined,
  kind: 'setup' | 'archive',
  yamlScript: string | undefined
): { script: string; localOnly: boolean } {
  const local = hookSettings?.scripts[kind]?.trim()
  const shared = yamlScript?.trim()
  const policy = resolveHookCommandSourcePolicy(hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(local)
  })
  if (policy === 'local-only') {
    return { script: local ?? '', localOnly: true }
  }
  if (policy === 'run-both') {
    return { script: [shared, local].filter(Boolean).join('\n'), localOnly: false }
  }
  return { script: shared ?? '', localOnly: false }
}

/**
 * What a hook of `kind` would run, trimmed: the effective script, and for setup orca.yaml's default
 * tab commands unless the repo runs its own commands only (they don't run then). Empty: nothing
 * runs. The tab lines are the clients' (`# defaultTabs[N] Title` then the command).
 */
export function hookRunContent(
  kind: 'setup' | 'archive',
  hookSettings: RepoHookSettings | undefined,
  yamlHooks: OrcaHooks | null
): string {
  const { script, localOnly } = effectiveScript(hookSettings, kind, yamlHooks?.scripts?.[kind])
  const tabs =
    kind === 'setup' && !localOnly
      ? (yamlHooks?.defaultTabs ?? []).flatMap((tab, index) => {
          const command = tab.command?.trim()
          return command
            ? [`# defaultTabs[${index + 1}]${tab.title ? ` ${tab.title}` : ''}\n${command}`]
            : []
        })
      : []
  return [script, ...tabs].filter(Boolean).join('\n\n').trim()
}
