// Fork-only (Pod): the CLI reads the product identity through main's loader, so that loader must
// survive electron-vite's out/main rewrite and stay outside app.asar like every CLI main import.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CLI_MAIN_ENTRY_NAMES } from '../build-plugins/plain-node-entry-guard'

const electronBuilderConfig: { asarUnpack: string[] } = createRequire(import.meta.url)(
  '../electron-builder.config.cjs'
)

function isUnpacked(file: string): boolean {
  return electronBuilderConfig.asarUnpack.some((pattern) =>
    pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
  )
}

describe('product identity CLI entry', () => {
  it('builds the identity loader at a stable path the CLI can require', () => {
    expect(CLI_MAIN_ENTRY_NAMES).toContain('product-identity/product-identity')
  })

  it.each(CLI_MAIN_ENTRY_NAMES)('unpacks out/main/%s.js from app.asar', (name) => {
    expect(isUnpacked(`out/main/${name}.js`)).toBe(true)
  })
})
