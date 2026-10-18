/**
 * Fork-only (Pod): a Pod terminal carries every renamed ORCA_ env name also as POD_, with the same
 * value, and no POD_ alias without its ORCA_ name (src/shared/pod-env-aliases.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import {
  POD_ALIASED_ORCA_ENV_NAMES,
  POD_ENV_ALIAS_EXCLUSIONS
} from '../../src/shared/pod-env-aliases'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product', 'identity.json')
  }
})
test.skip(process.platform === 'win32', 'Pod ships for macOS')

test('a Pod terminal exports each aliased ORCA_ name as POD_ with the same value', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  // Why names in and names out: the terminal compares the values itself, so none reach the disk.
  const script = testInfo.outputPath('compare-pod-env-aliases.sh')
  const result = testInfo.outputPath('pod-env-alias-findings.txt')
  writeFileSync(script, aliasComparisonScript())
  await execInTerminal(
    orcaPage,
    ptyId,
    buildShellCommandFromArgv(['/bin/sh', script, result], 'posix')
  )
  await expect.poll(() => existsSync(result), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(result, 'utf8').split('\n').filter(Boolean)).toEqual(['pane key aliased'])
})

/** A POSIX sh script that writes only the names of aliases that differ from their ORCA_ name. */
function aliasComparisonScript(): string {
  const aliased = POD_ALIASED_ORCA_ENV_NAMES.map((name) => name.slice('ORCA_'.length))
  const excluded = Object.keys(POD_ENV_ALIAS_EXCLUSIONS).filter((suffix) => suffix !== 'VERSION')
  return `out=$1
{
  [ -n "\${ORCA_PANE_KEY+x}" ] && [ "\${POD_PANE_KEY-}" = "\${ORCA_PANE_KEY}" ] && echo 'pane key aliased'
  for n in ${aliased.join(' ')}; do
    eval "orca_set=\\\${ORCA_$n+x} pod_set=\\\${POD_$n+x}"
    if [ "$orca_set" != "$pod_set" ]; then
      echo "mismatch $n"
    elif [ -n "$orca_set" ] && ! eval '[ "$ORCA_'"$n"'" = "$POD_'"$n"'" ]'; then
      echo "mismatch $n"
    fi
  done
  for n in ${excluded.join(' ')}; do
    eval "[ -z \\"\\\${POD_$n+x}\\" ]" || echo "excluded name aliased $n"
  done
} > "$out.part" && mv "$out.part" "$out"
`
}
