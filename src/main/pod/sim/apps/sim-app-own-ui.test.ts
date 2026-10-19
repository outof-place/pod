// What the real-device test takes for the app's own UI, on screens the 19.10 night run captured.
import { describe, expect, it } from 'vitest'
import { simAppOwnUi } from './sim-app-own-ui.test-support'

describe('the app’s own UI on a real device', () => {
  it('is Portivo’s map tab, whose snapshot names only "Map"', () => {
    expect(simAppOwnUi(['Map'], true)).toBe(true)
  })

  it('is not React Native’s red box after its bundle request gave up', () => {
    const redBox = [
      'Could not connect to development server.\n\nEnsure the following: - Node server is running and available on the same netw…',
      'Dismiss (ESC)',
      'Reload (⌘R)',
      'Copy (⌥⌘C)',
      'Extra Info (⌘E)'
    ]
    expect(simAppOwnUi(redBox, true)).toBe(false)
  })

  it('is not the loading banner, an empty splash, or the home screen once the app ended', () => {
    expect(simAppOwnUi(['Loading from Metro…'], true)).toBe(false)
    expect(simAppOwnUi([], true)).toBe(false)
    expect(simAppOwnUi(['Fitness', 'Watch', 'Contacts', 'Portivo', 'Safari'], false)).toBe(false)
  })
})
