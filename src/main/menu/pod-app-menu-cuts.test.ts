import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../shared/product/features'

async function loadCuts(profile: 'pod' | 'orca') {
  vi.resetModules()
  if (profile === 'pod') {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
  }
  return import('./pod-app-menu-cuts')
}

const promoItems = (): Electron.MenuItemConstructorOptions[] => [
  { type: 'separator' },
  { label: 'Explore Orca' },
  { label: 'Getting Started with Orca' }
]
const tasksItem: Electron.MenuItemConstructorOptions = {
  label: 'Show Tasks Button',
  type: 'checkbox'
}

describe('Pod app menu cuts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops the promo items and hides the tasks toggle in the Pod profile', async () => {
    const { podHelpPromoItems, podTasksMenuItem } = await loadCuts('pod')
    expect(podHelpPromoItems(promoItems())).toEqual([])
    expect(podTasksMenuItem(tasksItem)).toEqual({ ...tasksItem, visible: false })
  })

  it('keeps upstream items when the profile is not substituted', async () => {
    const { podHelpPromoItems, podTasksMenuItem } = await loadCuts('orca')
    expect(podHelpPromoItems(promoItems())).toEqual(promoItems())
    expect(podTasksMenuItem(tasksItem)).toBe(tasksItem)
  })
})
