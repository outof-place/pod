import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import { parsePluginVmRecipeArtifact } from '../../../shared/plugins/plugin-vm-recipe-artifact'
import { POD_ORBSTACK_MACHINE_PREFIX } from '../../../shared/pod-orbstack-types'

const PRINT_CONNECTION = [
  "esc() { printf '%s' \"$1\" | sed 's/[\\\\\"]/\\\\&/g'; }",
  'printf \'{"schemaVersion":1,"connection":{"type":"ssh","projectRoot":"%s","target":{"label":"OrbStack %s","host":"127.0.0.1","port":32222,"username":"%s@%s","identityFile":"%s","identitiesOnly":true}},"userData":{"provider":"orbstack","machine":"%s"}}\\n\' "$(esc "$ORCA_REPO_PATH")" "$(esc "${ORCA_WORKSPACE_NAME:-$name}")" "$(esc "$user")" "$name" "$(esc "$HOME/.orbstack/ssh/id_ed25519")" "$name"'
]

/** Same lifecycle as ~/.local/share/orca-native/recipes/orbstack-ubuntu.json, minus the git-only path check. */
export const POD_ORBSTACK_BUILTIN_RECIPE: OrcaVmRecipe = {
  id: 'pod-orbstack-ubuntu',
  name: 'OrbStack Ubuntu',
  description: 'A disposable OrbStack Ubuntu 24.04 machine that opens the worktree in place.',
  create: [
    'set -eu',
    '# Never let the name be empty: a bare `orb stop` stops every machine and Docker.',
    'name="${ORCA_VM_INSTANCE_ID:?ORCA_VM_INSTANCE_ID is not set}"',
    'if orb info "$name" >/dev/null 2>&1; then echo "OrbStack machine $name already exists" >&2; exit 1; fi',
    'trap \'[ -n "${ok:-}" ] || orb delete -f "$name" >/dev/null 2>&1 || true\' EXIT',
    "trap 'exit 1' INT TERM",
    'orb create ubuntu:24.04 "$name" >&2',
    'orb run -m "$name" -u root sh -c \'command -v git >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; }\' >&2',
    '# OrbStack shares /Users at the same path, so the machine opens the worktree in place.',
    'orb run -m "$name" test -d "$ORCA_REPO_PATH" || { echo "The machine cannot see $ORCA_REPO_PATH. OrbStack shares /Users and /private, not the /var and /tmp links." >&2; exit 1; }',
    'user="$(orb run -m "$name" id -un)"',
    ...PRINT_CONNECTION,
    'ok=1'
  ].join('\n'),
  suspend: 'orb stop "${ORCA_VM_INSTANCE_ID:?ORCA_VM_INSTANCE_ID is not set}"',
  resume: [
    'set -eu',
    'name="${ORCA_VM_INSTANCE_ID:?ORCA_VM_INSTANCE_ID is not set}"',
    'orb start "$name" >&2',
    'user="$(orb run -m "$name" id -un)"',
    ...PRINT_CONNECTION
  ].join('\n'),
  destroy:
    '{ name="${ORCA_VM_INSTANCE_ID:-$(sed -n \'s/.*"instanceId":"\\([^"]*\\)".*/\\1/p\')}"; : "${name:?No instance id in ORCA_VM_INSTANCE_ID or the stdin payload}"; if orb info "$name" >/dev/null 2>&1; then orb delete -f "$name"; fi; }'
}

/** A plugin-format recipe file replaces the built-in one, so a repo can add its toolchain. */
export function loadPodOrbstackRecipe(overridePath: string): OrcaVmRecipe {
  if (!existsSync(overridePath)) {
    return POD_ORBSTACK_BUILTIN_RECIPE
  }
  return parsePluginVmRecipeArtifact(readFileSync(overridePath, 'utf8'))
}

const MACHINE_NAME_PATTERN = /^pod-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `pod-<folder>-<hash>[-sbx]`: readable in `orb list`, stable per worktree, a valid hostname label. */
export function podOrbstackMachineName(
  worktreeId: string,
  worktreePath: string,
  kind: 'shared' | 'sandbox' = 'shared'
): string {
  const slug =
    basename(worktreePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'worktree'
  const hash = createHash('sha256').update(worktreeId).digest('hex').slice(0, 8)
  return `${POD_ORBSTACK_MACHINE_PREFIX}${slug}-${hash}${kind === 'sandbox' ? '-sbx' : ''}`
}

export function isValidPodOrbstackMachineName(name: string): boolean {
  return name.length <= 63 && MACHINE_NAME_PATTERN.test(name)
}
