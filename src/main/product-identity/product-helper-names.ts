// Fork-only (Pod): product packaging (product/helper-names.cjs) renames Orca's bundled macOS helpers
// after the product, so Finder, Activity Monitor and Privacy & Security never list an Orca name.
// Upstream lookups pass their upstream name through here; without an identity it comes back as is.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getProductIdentity, type ProductIdentity } from './product-identity'

const COMPUTER_USE_NAME = 'Orca Computer Use'
const COMPUTER_USE_EXECUTABLE = 'orca-computer-use-macos'
const MACOS_HELPERS = ['orca-notification-status', 'orca-keyboard-layout']

/** Upstream name → product name; product/helper-names.cjs builds the same table for packaging. */
export function productHelperNameTable(identity: ProductIdentity): Map<string, string> {
  const table = new Map<string, string>()
  const prefix = `${identity.packageName}-`
  if (identity.computerUseDisplayName) {
    table.set(`${COMPUTER_USE_NAME}.app`, `${identity.computerUseDisplayName}.app`)
    table.set(COMPUTER_USE_NAME, identity.computerUseDisplayName)
    table.set(COMPUTER_USE_EXECUTABLE, COMPUTER_USE_EXECUTABLE.replace(/^orca-/, prefix))
  }
  for (const helper of MACOS_HELPERS) {
    table.set(helper, helper.replace(/^orca-/, prefix))
  }
  for (const [upstream, product] of table) {
    if (upstream === product) {
      table.delete(upstream)
    }
  }
  return table
}

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
  const identity = getProductIdentity()
  if (!identity) {
    return text
  }
  // Why one pass: "Orca Computer Use.app" and "Orca Computer Use" overlap.
  const table = productHelperNameTable(identity)
  const keys = [...table.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  return keys.length === 0
    ? text
    : text.replace(new RegExp(keys.join('|'), 'g'), (name) => table.get(name) ?? name)
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
