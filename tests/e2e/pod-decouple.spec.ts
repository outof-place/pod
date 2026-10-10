import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

// Why from identity.json: the decouple codemod rewrites these folder names wherever code spells them.
const identity = JSON.parse(readFileSync(path.join(process.cwd(), 'product/identity.json'), 'utf8'))
const PRODUCT_HOME: string = identity.homeDirName
const LEGACY_HOME: string = identity.legacyProfile.homeDirName
const LEGACY_ENV_PREFIX = 'ORCA_'

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product/identity.json')
  }
})

test('a fresh product profile keeps per-user state in its own home and exports only its env names', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.skip(process.platform === 'win32', 'Pod ships for macOS')
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

  const terminalNames = readFileSync(dump, 'utf8')
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
  // Whatever the app process inherited (the harness's own inputs) passes through; nothing the app
  // adds may carry the legacy prefix.
  const inherited = new Set(
    await electronApp.evaluate(() =>
      Object.keys(process.env).filter((name) => name.startsWith('ORCA_'))
    )
  )
  expect(
    terminalNames.filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && !inherited.has(name))
  ).toEqual([])
  expect(terminalNames).toEqual(expect.arrayContaining(['POD_PANE_KEY', 'POD_TAB_ID']))

  // Hook scripts install lazily; the keybindings file is per-user state the app writes on demand.
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const keybindings = await orcaPage.evaluate(() => window.api.keybindings.ensureFile())
  expect(keybindings.path).toBe(path.join(home, PRODUCT_HOME, 'keybindings.json'))
  expect(existsSync(keybindings.path)).toBe(true)
  expect(existsSync(path.join(home, LEGACY_HOME))).toBe(false)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  expect(
    JSON.parse(readFileSync(path.join(userData, 'product-home-move.json'), 'utf8'))
  ).toMatchObject({ result: { status: 'not-needed', reason: 'no-legacy-home' } })
})
