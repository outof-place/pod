/**
 * Fork-only (Pod): proves which font Chromium actually draws, not just the CSS stack. macOS keeps
 * SF Mono only inside Terminal.app, so without Pod's faces "SF Mono" silently resolves to Menlo.
 */
import path from 'node:path'
import type { CDPSession } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product', 'identity.json')
  }
})

async function platformFontFamilies(cdp: CDPSession, selector: string): Promise<string[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) {
    return []
  }
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
  return fonts.map((font) => font.familyName)
}

test('a Pod terminal draws SF Mono from Terminal.app on macOS', async ({ orcaPage }) => {
  test.skip(process.platform !== 'darwin', 'SF Mono ships inside macOS Terminal.app')
  await ensureTerminalVisible(orcaPage, 30_000)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')

  // xterm draws on a canvas with its fontFamily option, so render that exact font on a probe.
  const terminalFont = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane')
    }
    const { fontFamily, fontSize, fontWeight } = pane.terminal.options
    const probe = document.createElement('span')
    probe.id = 'pod-terminal-font-probe'
    probe.textContent = 'W0il{}'
    probe.style.fontFamily = fontFamily ?? ''
    probe.style.fontSize = `${fontSize ?? 14}px`
    probe.style.fontWeight = String(fontWeight ?? 'normal')
    document.body.append(probe)
    return fontFamily ?? ''
  })
  expect(terminalFont.startsWith('"SF Mono"')).toBe(true)
  await expect
    .poll(() => platformFontFamilies(cdp, '#pod-terminal-font-probe'), { timeout: 15_000 })
    .toEqual(['SF Mono'])
  const loaded = await orcaPage.evaluate(
    () =>
      [...document.fonts].filter(
        (face) => face.family.replaceAll('"', '') === 'SF Mono' && face.status === 'loaded'
      ).length
  )
  expect(loaded).toBeGreaterThan(0)
})
