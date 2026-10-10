// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductUiIdentity } from '../../../shared/product-ui-identity'
import { _resetProductUiIdentityForTests } from './product-ui-identity'
import { installProductSystemFonts, sfMonoFontFaceCss } from './product-system-fonts'

const POD: ProductUiIdentity = {
  displayName: 'Pod',
  cliName: 'podx',
  stablyServices: false,
  repositoryUrl: 'https://github.com/outof-place/pod'
}

const load = vi.fn(async (_font: string): Promise<FontFace[]> => [])

function stamp(product: ProductUiIdentity | null, userAgent: string): void {
  Object.assign(window, { api: { product: { get: () => product } } })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  _resetProductUiIdentityForTests()
}

describe('product system fonts', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
  })

  afterEach(() => {
    document.getElementById('pod-system-fonts')?.remove()
    Reflect.deleteProperty(window, 'api')
    _resetProductUiIdentityForTests()
    vi.restoreAllMocks()
    load.mockClear()
  })

  it('declares every SF Mono face from Terminal.app, a system-wide install first', () => {
    const css = sfMonoFontFaceCss()
    expect(css.match(/@font-face/g)).toHaveLength(12)
    expect(css).toContain('local("SF Mono Medium"), local("SFMono-Medium")')
    expect(css).toContain(
      'url("file:///System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/SF-Mono-SemiboldItalic.otf")'
    )
    expect(css).toContain('font-weight: 800;')
  })

  it('leaves upstream Orca alone', () => {
    stamp(null, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    installProductSystemFonts()
    expect(document.getElementById('pod-system-fonts')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('leaves non-macOS product builds alone', () => {
    stamp(POD, 'Mozilla/5.0 (X11; Linux x86_64)')
    installProductSystemFonts()
    expect(document.getElementById('pod-system-fonts')).toBeNull()
  })

  it('declares SF Mono once in a macOS product build and starts loading it', () => {
    stamp(POD, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    installProductSystemFonts()
    installProductSystemFonts()
    expect(document.querySelectorAll('#pod-system-fonts')).toHaveLength(1)
    expect(load.mock.calls.map(([font]) => font)).toEqual([
      '400 13px "SF Mono"',
      '500 13px "SF Mono"',
      '700 13px "SF Mono"'
    ])
  })
})
