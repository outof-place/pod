// Fork-only (Pod): product packaging (product/helper-names.cjs) renames Orca's bundled macOS helpers
// after the product. The name table and the copy rewrite live here, free of main's imports, so the
// CLI bundle can load them; main's product-helper-names.ts applies them to the running product.

export const COMPUTER_USE_NAME = 'Orca Computer Use'
const COMPUTER_USE_EXECUTABLE = 'orca-computer-use-macos'
const MACOS_HELPERS = ['orca-notification-status', 'orca-keyboard-layout']

/** The identity fields helper names follow; a ProductIdentity has both. */
export type ProductHelperIdentity = {
  packageName: string
  computerUseDisplayName: string | null
}

/** Upstream name → product name; product/helper-names.cjs builds the same table for packaging. */
export function productHelperNameTable(identity: ProductHelperIdentity): Map<string, string> {
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

/** Upstream copy or a process-match pattern naming a helper, with this identity's helper names. */
export function productHelperCopyFor(identity: ProductHelperIdentity | null, text: string): string {
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
