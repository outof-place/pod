/**
 * Fork-only (Pod): a fresh profile draws its UI in the macOS system font (SF Pro). Asserts the font
 * Chromium actually draws, not just the CSS stack.
 */
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.skip(process.platform !== 'darwin', 'SF Pro is the macOS system font')

test('a fresh profile draws its UI in the macOS system font', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  expect(await orcaPage.evaluate(() => window.__store?.getState().settings?.appFontFamily)).toBe(
    'system-ui'
  )
  await expect
    .poll(() =>
      orcaPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--app-font-family').trim()
      )
    )
    .toMatch(/^system-ui,/)

  // A probe that inherits the page font, so the check covers what every UI text node gets.
  await orcaPage.evaluate(() => {
    const probe = document.createElement('span')
    probe.id = 'pod-ui-font-probe'
    probe.textContent = 'Pod workspaces'
    document.body.append(probe)
  })
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const probeFonts = async (): Promise<string[]> => {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#pod-ui-font-probe'
    })
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.map((font) => font.familyName)
  }
  // Why ".SF NS": Chromium names the macOS system UI font by its internal family.
  await expect.poll(probeFonts, { timeout: 15_000 }).toEqual(['.SF NS'])
})
