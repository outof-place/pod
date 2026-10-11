// Fork-only (Pod): product packaging (product/helper-names.cjs) renames Orca's bundled macOS helpers
// after the product, so Finder, Activity Monitor and Privacy & Security never list an Orca name.
// Upstream lookups pass their upstream name through here; without an identity it comes back as is.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  COMPUTER_USE_NAME,
  productHelperCopyFor,
  productHelperNameTable
} from '../../shared/product-helper-names'
import { getProductIdentity } from './product-identity'

export { productHelperNameTable }

export function productHelperName(upstreamName: string): string {
  const identity = getProductIdentity()
  return (identity && productHelperNameTable(identity).get(upstreamName)) ?? upstreamName
}

/** Upstream's helper path, renamed when the product's file is there (dev builds keep Orca's names). */
export function productHelperPath(upstreamPath: string): string {
  const upstreamName = basename(upstreamPath)
  const productPath = join(dirname(upstreamPath), productHelperName(upstreamName))
  return productPath !== upstreamPath && existsSync(productPath) ? productPath : upstreamPath
}

/** Upstream copy or a process-match pattern naming a helper, with the product's helper names. */
export function productHelperCopy(text: string): string {
  return productHelperCopyFor(getProductIdentity(), text)
}

/** A name Orca gives a process of its own (ps shows bash's $0 `orca-tcc-login`); not a file. */
export function productProcessName(upstreamName: string): string {
  const identity = getProductIdentity()
  return identity ? upstreamName.replace(/^orca-/, `${identity.packageName}-`) : upstreamName
}

export function computerUseAppNotFound(): string {
  return productHelperCopy(`${COMPUTER_USE_NAME}.app was not found`)
}

/** Process-match patterns naming an upstream helper, plus the same patterns with its product name. */
export function productHelperPatterns(patterns: readonly string[]): string[] {
  return [...new Set([...patterns, ...patterns.map(productHelperCopy)])]
}
