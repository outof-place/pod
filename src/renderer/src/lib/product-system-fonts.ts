// Fork-only (Pod): macOS keeps SF Mono only inside Terminal.app, so Chromium cannot resolve the
// "SF Mono" family the terminal and editor ask for and silently draws Menlo. A product build
// declares those faces from Terminal.app's own files; a system-wide SF Mono still wins via local().
import { getProductUiIdentity } from './product-ui-identity'

const TERMINAL_APP_FONT_DIRS = [
  'file:///System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/',
  // Why: Terminal.app sat here before macOS 10.15 moved system apps under /System.
  'file:///Applications/Utilities/Terminal.app/Contents/Resources/Fonts/'
]
const STYLE_ELEMENT_ID = 'pod-system-fonts'

const SF_MONO_WEIGHTS = [
  ['Light', 300],
  ['Regular', 400],
  ['Medium', 500],
  ['Semibold', 600],
  ['Bold', 700],
  ['Heavy', 800]
] as const

export function sfMonoFontFaceCss(): string {
  return SF_MONO_WEIGHTS.flatMap(([name, weight]) =>
    [false, true].map((italic) => {
      const face = `${name}${italic ? 'Italic' : ''}`
      return [
        '@font-face {',
        '  font-family: "SF Mono";',
        `  src: local("SF Mono ${name}${italic ? ' Italic' : ''}"), local("SFMono-${face}"),`,
        `    ${TERMINAL_APP_FONT_DIRS.map((dir) => `url("${dir}SF-Mono-${face}.otf") format("opentype")`).join(', ')};`,
        `  font-weight: ${weight};`,
        `  font-style: ${italic ? 'italic' : 'normal'};`,
        '}'
      ].join('\n')
    })
  ).join('\n')
}

/** Declares SF Mono in a product build on macOS and starts loading the common weights. */
export function installProductSystemFonts(doc: Document = document): void {
  if (!getProductUiIdentity() || !navigator.userAgent.includes('Mac')) {
    return
  }
  if (doc.getElementById(STYLE_ELEMENT_ID)) {
    return
  }
  const style = doc.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = sfMonoFontFaceCss()
  doc.head.append(style)
  // Why load now: faces load lazily, and a terminal that measures its cells first keeps Menlo's.
  for (const weight of [400, 500, 700]) {
    void doc.fonts.load(`${weight} 13px "SF Mono"`).catch(() => undefined)
  }
}
