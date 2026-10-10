/**
 * Fork-only (Pod): the Help menu's feature tour and setup guide items are promos. The Pod profile
 * compiles them out (src/shared/product/features.ts); POD_BUILD_PROFILE=orca keeps both.
 */
import { test, expect } from './helpers/orca-app'
import { e2ePodFeatures } from './helpers/pod-build-profile'

// Why both names: pod/overlay brands these items after the product, upstream names Orca.
const PROMO_MENU_LABEL = /^(Explore|Getting Started with) (Orca|Pod)$/

test('Help menu carries the promo items only when the profile keeps promos', async ({
  electronApp,
  orcaPage
}) => {
  await expect(orcaPage.locator('body')).toBeVisible()
  const readVisibleMenuLabels = (): Promise<string[]> =>
    electronApp.evaluate(({ Menu }) => {
      const labels: string[] = []
      const walk = (items: Electron.MenuItem[]): void => {
        for (const item of items) {
          if (item.visible && item.label) {
            labels.push(item.label)
          }
          walk(item.submenu?.items ?? [])
        }
      }
      walk(Menu.getApplicationMenu()?.items ?? [])
      return labels
    })

  await expect.poll(async () => (await readVisibleMenuLabels()).length).toBeGreaterThan(0)
  const promoLabels = (await readVisibleMenuLabels()).filter((label) =>
    PROMO_MENU_LABEL.test(label)
  )
  expect(promoLabels).toHaveLength(e2ePodFeatures.featurePromos ? 2 : 0)
})
