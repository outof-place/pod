// Fork-only (Pod): the CLI reads the product identity through main's loader, so that loader must
// survive electron-vite's out/main rewrite and stay outside app.asar like every CLI main import.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
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

const SRC = resolve(import.meta.dirname, '../../src')
const RUNTIME_IMPORT = /^(?:import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm

/** src/main modules under product-identity/ that src/cli loads at runtime (type imports are erased). */
function cliRuntimeProductIdentityImports(): string[] {
  const cli = join(SRC, 'cli')
  const found = new Set<string>()
  for (const name of readdirSync(cli, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) {
      continue
    }
    const file = join(cli, name)
    for (const [, typeOnly, specifier] of readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)) {
      const target = relative(join(SRC, 'main'), resolve(dirname(file), specifier))
        .split('\\')
        .join('/')
      if (!typeOnly && target.startsWith('product-identity/')) {
        found.add(target)
      }
    }
  }
  return [...found].sort()
}

describe('product identity CLI entry', () => {
  // Why: electron-vite replaces out/main, so a CLI import of any other main module is missing at
  // runtime (verify-skills-cli-runtime catches it only after a full build); shared code goes in src/shared.
  it('loads from main/product-identity only modules built as CLI main entries', () => {
    const entries: readonly string[] = CLI_MAIN_ENTRY_NAMES
    const imports = cliRuntimeProductIdentityImports()
    expect(imports).toContain('product-identity/product-identity')
    expect(imports.filter((name) => !entries.includes(name))).toEqual([])
  })

  it('builds the identity loader at a stable path the CLI can require', () => {
    expect(CLI_MAIN_ENTRY_NAMES).toContain('product-identity/product-identity')
  })

  it.each(CLI_MAIN_ENTRY_NAMES)('unpacks out/main/%s.js from app.asar', (name) => {
    expect(isUnpacked(`out/main/${name}.js`)).toBe(true)
  })
})
