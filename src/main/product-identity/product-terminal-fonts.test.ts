import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from './product-identity'
import type { ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import {
  productTerminalFontFiles,
  registerProductTerminalFonts,
  type ProductTerminalFontFs
} from './product-terminal-fonts'

const TERMINAL_FONTS = '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts'

function fakeFs(present: string[], listing: string[]): ProductTerminalFontFs {
  return { exists: (path) => present.includes(path), list: () => listing }
}

describe('product terminal fonts', () => {
  afterEach(() => {
    identity.current = null
  })

  it("lists Terminal.app's SF Mono files when SF Mono is not installed", () => {
    const fs = fakeFs(
      [TERMINAL_FONTS],
      ['SF-Mono-Regular.otf', 'SFMono-Terminal.ttf', 'SF-Mono-BoldItalic.otf', 'Other.otf']
    )
    expect(productTerminalFontFiles('/Users/me', fs)).toEqual([
      `${TERMINAL_FONTS}/SF-Mono-BoldItalic.otf`,
      `${TERMINAL_FONTS}/SF-Mono-Regular.otf`
    ])
  })

  it('registers nothing when SF Mono is already installed for the user or the system', () => {
    const listing = ['SF-Mono-Regular.otf']
    for (const installed of ['/Users/me/Library/Fonts', '/Library/Fonts']) {
      const fs = fakeFs([TERMINAL_FONTS, `${installed}/SF-Mono-Regular.otf`], listing)
      expect(productTerminalFontFiles('/Users/me', fs)).toEqual([])
    }
    expect(productTerminalFontFiles('/Users/me', fakeFs([], listing))).toEqual([])
  })

  it('touches the addon only in a macOS product build', () => {
    const registerProcessFonts = vi.fn(() => 0)
    registerProductTerminalFonts({ registerProcessFonts })
    expect(registerProcessFonts).not.toHaveBeenCalled()
    identity.current = podIdentityWithoutStablyServices()
    // An older addon without the export must not throw.
    expect(() => registerProductTerminalFonts({})).not.toThrow()
  })
})
