#!/usr/bin/env node
// Review renders: the icon through Icon Composer's own renderer (ictool) and the menu bar template on both bars.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const BRAND = path.dirname(new URL(import.meta.url).pathname)
const OUT = path.join(BRAND, 'preview')
const DOC = path.join(path.dirname(BRAND), 'icon-source', 'icon.icon')
const ICTOOL =
  '/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })

mkdirSync(OUT, { recursive: true })

const RENDITIONS = ['Default', 'Dark', 'ClearLight', 'ClearDark', 'TintedLight', 'TintedDark']
for (const rendition of RENDITIONS) {
  for (const size of [1024, 128, 32]) {
    run(ICTOOL, [
      DOC,
      '--export-image',
      '--output-file',
      path.join(OUT, `icon-${rendition}-${size}.png`),
      '--platform',
      'macOS',
      '--rendition',
      rendition,
      '--width',
      String(size),
      '--height',
      String(size),
      '--scale',
      '1',
      ...(rendition.startsWith('Tinted') ? ['--tint-color', '0.55', '--tint-strength', '0.8'] : [])
    ])
  }
}

// Menu bar strips at 2x: macOS's light and dark bars, the template drawn as the system draws one.
const bar = path.join(BRAND, 'pod-menu-barTemplate@2x.png')
for (const [name, bg, ink] of [
  ['light', '#ececec', '#000000d9'],
  ['dark', '#1e1e1e', '#ffffffe6']
]) {
  run('magick', [
    '-size',
    '360x48',
    `xc:${bg}`,
    '(',
    bar,
    '-alpha',
    'extract',
    '-background',
    ink,
    '-alpha',
    'shape',
    ')',
    '-gravity',
    'center',
    '-composite',
    path.join(OUT, `menu-bar-${name}@2x.png`)
  ])
}

// One sheet: Default/Dark at 1024, 128 and 32, every rendition at 128, and the two menu bars.
const p = (n) => path.join(OUT, n)
run('magick', [
  '(',
  p('icon-Default-1024.png'),
  p('icon-Dark-1024.png'),
  '+append',
  ')',
  '(',
  ...RENDITIONS.map((r) => p(`icon-${r}-128.png`)),
  '+append',
  '-gravity',
  'center',
  '-background',
  '#7f7f7f',
  '-extent',
  '2048x160',
  ')',
  '(',
  ...RENDITIONS.map((r) => p(`icon-${r}-32.png`)),
  '-background',
  '#7f7f7f',
  '-gravity',
  'center',
  '-extent',
  '128x64',
  '+append',
  '-extent',
  '2048x64',
  ')',
  '(',
  p('menu-bar-light@2x.png'),
  p('menu-bar-dark@2x.png'),
  '+append',
  '-gravity',
  'center',
  '-background',
  '#7f7f7f',
  '-extent',
  '2048x96',
  ')',
  '-background',
  '#7f7f7f',
  '-gravity',
  'center',
  '-append',
  p('sheet.png')
])
console.log(`preview: ${OUT}`)
