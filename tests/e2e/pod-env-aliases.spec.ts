/**
 * Fork-only (Pod): a Pod terminal carries every renamed ORCA_ env name also as POD_, with the same
 * value, and no POD_ alias without its ORCA_ name (src/shared/pod-env-aliases.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import {
  POD_ALIASED_ORCA_ENV_NAMES,
  POD_ENV_ALIAS_EXCLUSIONS,
  podSpellingOf
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
  const dump = testInfo.outputPath('terminal-env.txt')
  await execInTerminal(
    orcaPage,
    ptyId,
    buildShellCommandFromArgv(['/bin/sh', '-c', `env > "${dump}"`], 'posix')
  )
  await expect
    .poll(() => existsSync(dump) && readFileSync(dump, 'utf8').includes('POD_PANE_KEY='), {
      timeout: 30_000
    })
    .toBe(true)

  const terminalEnv = new Map(
    readFileSync(dump, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
  expect(terminalEnv.get('POD_PANE_KEY')).toBe(terminalEnv.get('ORCA_PANE_KEY'))
  expect(terminalEnv.get('POD_TAB_ID')).toBe(terminalEnv.get('ORCA_TAB_ID'))
  for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
    expect(terminalEnv.get(podSpellingOf(name)), podSpellingOf(name)).toBe(terminalEnv.get(name))
  }
  for (const suffix of Object.keys(POD_ENV_ALIAS_EXCLUSIONS)) {
    if (suffix !== 'VERSION') {
      expect(terminalEnv.has(`POD_${suffix}`), suffix).toBe(false)
    }
  }
})
