/**
 * Fork-only (Pod): a fresh profile of a product build opens native Ghostty panes with no settings
 * change, because Pod defaults the native terminal on.
 */
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  nativeScreenText,
  nativeSurfaceField,
  nativeSurfaceIds
} from './helpers/native-terminal-debug'

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product', 'identity.json')
  }
})
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

test('a fresh Pod profile draws its first terminal pane natively', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  expect(
    await orcaPage.evaluate(() => window.__store?.getState().settings?.experimentalNativeTerminal)
  ).toBe(true)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)

  let surfaceId = 0
  await expect
    .poll(async () => {
      surfaceId = (await nativeSurfaceIds(electronApp)).at(-1) ?? 0
      return surfaceId
    })
    .toBeGreaterThan(0)
  // The surface is the one drawing the active pane, and it is on screen.
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => document.querySelector(`[data-native-surface-id="${id}"]`) !== null,
        surfaceId
      )
    )
    .toBe(true)
  await expect.poll(async () => nativeSurfaceField(electronApp, surfaceId, 'hidden')).toBe(false)
  await execInTerminal(orcaPage, ptyId, "printf 'POD-%s\\n' NATIVE")
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('POD-NATIVE')

  // Pod lists the switch under Terminal, already on, and not under Experimental.
  const openPane = (pane: 'terminal' | 'experimental'): Promise<void> =>
    orcaPage.evaluate((target) => {
      const state = window.__store?.getState()
      state?.setSettingsSearchQuery('')
      state?.openSettingsTarget({ pane: target, repoId: null })
      state?.openSettingsPage()
    }, pane)
  await openPane('terminal')
  const podSwitch = orcaPage.getByRole('switch', { name: 'Native terminal (Ghostty, Metal)' })
  await expect(podSwitch).toBeVisible()
  await expect(podSwitch).toBeChecked()
  await openPane('experimental')
  await expect(orcaPage.getByRole('heading', { name: 'Experimental', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('switch', { name: 'Native terminal', exact: true })).toHaveCount(
    0
  )
})
