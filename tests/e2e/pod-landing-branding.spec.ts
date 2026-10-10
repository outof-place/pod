/**
 * Fork-only (Pod): the Landing screen of a product build names Pod. Orca may appear only in the
 * credit ("Built on Orca …") and the MIT notice, never in the product's own copy.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseProductIdentity } from '../../src/main/product-identity/product-identity'
import { test, expect } from './helpers/orca-app'

const identityPath = path.join(process.cwd(), 'product', 'identity.json')
const { credits } = parseProductIdentity(JSON.parse(readFileSync(identityPath, 'utf8')))

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { POD_E2E_PRODUCT_IDENTITY_PATH: identityPath }
})

function isCreditLine(line: string): boolean {
  return line.includes(credits) || /^Built on Orca\b/.test(line.trim()) || /\bMIT\b/.test(line)
}

test('Landing names Pod and never Orca outside the credit', async ({ orcaPage }) => {
  const heading = orcaPage.locator('h1').first()
  await expect(heading).toBeVisible({ timeout: 60_000 })
  await expect(heading).toHaveText(/pod/i)

  const text = await orcaPage.locator('body').innerText()
  const alts = await orcaPage
    .locator('img[alt]')
    .evaluateAll((images) => images.map((image) => image.getAttribute('alt') ?? ''))
  expect(alts.some((alt) => /pod/i.test(alt))).toBe(true)
  const orcaLines = [...text.split('\n'), ...alts].filter((line) => /orca/i.test(line))
  expect(orcaLines.filter((line) => !isCreditLine(line))).toEqual([])
})
