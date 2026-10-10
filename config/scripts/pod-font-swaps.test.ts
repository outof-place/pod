import { describe, expect, it } from 'vitest'
import { prunePodManifest, swapPodFontFaces } from '../build-plugins/pod-build-profile'

type Bundle = Record<string, { type: string; fileName: string; source?: string | Uint8Array }>

function bundleOf(files: Record<string, string | Uint8Array>): Bundle {
  return Object.fromEntries(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      { type: 'asset', fileName, source }
    ])
  )
}

function cssOf(bundle: Bundle, fileName: string): string {
  const source = bundle[fileName]?.source
  return typeof source === 'string' ? source : new TextDecoder().decode(source)
}

const GEIST_TO_SYSTEM = [{ family: 'Geist', to: 'system-ui' }]

// Shape of the minified renderer CSS electron-vite emits for main.css and its @imports.
const RENDERER_CSS =
  '@font-face{font-family:Geist;src:url(./Geist-Variable-AbC123.woff2)format("woff2");font-weight:100 900}' +
  '@font-face{font-family:Orca Nerd Font Symbols;src:url(./SymbolsNerdFontMono-Regular-x1.woff2)format("woff2")}' +
  ':root{--app-font-family:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
  'body{font-family:var(--app-font-family,"Geist",-apple-system,sans-serif)}' +
  '.epr{font-family:Geist,sans-serif}'

describe('pod-font-swaps', () => {
  it('drops the face and its file and swaps the family in every font list', () => {
    const bundle = bundleOf({
      'assets/index-1.css': RENDERER_CSS,
      'assets/Geist-Variable-AbC123.woff2': 'w',
      'assets/SymbolsNerdFontMono-Regular-x1.woff2': 's'
    })
    expect(swapPodFontFaces(bundle, GEIST_TO_SYSTEM)).toEqual(
      new Set(['assets/Geist-Variable-AbC123.woff2'])
    )

    const css = cssOf(bundle, 'assets/index-1.css')
    expect(css).not.toMatch(/Geist/)
    expect(css).toContain('--app-font-family:system-ui,-apple-system')
    expect(css).toContain('var(--app-font-family,system-ui,-apple-system')
    expect(css).toContain('.epr{font-family:system-ui,sans-serif}')
    expect(css).toContain('font-family:Orca Nerd Font Symbols')
    expect(Object.keys(bundle)).toEqual([
      'assets/index-1.css',
      'assets/SymbolsNerdFontMono-Regular-x1.woff2'
    ])
  })

  it('reads CSS emitted as bytes', () => {
    const bundle = bundleOf({
      'a.css': new TextEncoder().encode(RENDERER_CSS),
      'Geist-Variable-AbC123.woff2': 'w'
    })
    swapPodFontFaces(bundle, GEIST_TO_SYSTEM)
    expect(cssOf(bundle, 'a.css')).not.toMatch(/Geist/)
  })

  it('fails the build when the face is gone, so a rename cannot ship the font again', () => {
    const bundle = bundleOf({ 'a.css': 'body{font-family:"Geist Sans",sans-serif}' })
    expect(() => swapPodFontFaces(bundle, GEIST_TO_SYSTEM)).toThrow(/no @font-face for Geist/)
  })

  it('fails the build when the face file is missing from the bundle', () => {
    const bundle = bundleOf({ 'a.css': RENDERER_CSS })
    expect(() => swapPodFontFaces(bundle, GEIST_TO_SYSTEM)).toThrow(
      /Geist-Variable-AbC123\.woff2 is not in the bundle/
    )
  })

  it('prunes the dropped file from the Vite manifest the web client projection reads', () => {
    const dropped = new Set(['assets/Geist-Variable-AbC123.woff2'])
    const manifest = {
      '_I18nProvider.js': {
        file: 'assets/I18nProvider.js',
        css: ['assets/I18nProvider.css'],
        assets: ['assets/Geist-Variable-AbC123.woff2', 'assets/SymbolsNerdFontMono-x1.woff2']
      },
      'src/assets/fonts/Geist-Variable.woff2': {
        file: 'assets/Geist-Variable-AbC123.woff2',
        src: 'src/assets/fonts/Geist-Variable.woff2'
      },
      'web-index.html': { file: 'web-index.html', isEntry: true }
    }
    expect(prunePodManifest(manifest, dropped)).toEqual({
      '_I18nProvider.js': {
        file: 'assets/I18nProvider.js',
        css: ['assets/I18nProvider.css'],
        assets: ['assets/SymbolsNerdFontMono-x1.woff2']
      },
      'web-index.html': { file: 'web-index.html', isEntry: true }
    })
  })
})
