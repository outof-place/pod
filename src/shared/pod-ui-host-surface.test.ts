import { describe, expect, it } from 'vitest'
import { isPodUiHostSurfaceNavigation } from './pod-ui-host-surface'

describe('isPodUiHostSurfaceNavigation', () => {
  it('takes a surface, a section and optional string fields', () => {
    expect(isPodUiHostSurfaceNavigation({ surface: 'settings', section: 'accounts' })).toBe(true)
    expect(
      isPodUiHostSurfaceNavigation({ surface: 'window', section: 'automations', item: 'a-1' })
    ).toBe(true)
    expect(isPodUiHostSurfaceNavigation({ surface: 'terminal', section: 'x' })).toBe(false)
    expect(isPodUiHostSurfaceNavigation({ surface: 'settings' })).toBe(false)
    expect(isPodUiHostSurfaceNavigation({ surface: 'settings', section: 'repo', repoId: 1 })).toBe(
      false
    )
    expect(isPodUiHostSurfaceNavigation(null)).toBe(false)
  })
})
