// Fork-only (Pod): the part of a downstream product's identity the renderer needs. Main stamps it as
// a command-line argument for the reason given in browser-client-host-id-argument.ts.
const PREFIX = '--orca-product-ui-identity='

export type ProductUiIdentity = {
  displayName: string
  cliName: string
  /** False when the product ships without Stably's hosted services. */
  stablyServices: boolean
  /** The product's own GitHub repository, for issue and release links. */
  repositoryUrl: string | null
}

export function formatProductUiIdentityArgument(identity: ProductUiIdentity): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify(identity))}`
}

/** Null for upstream Orca, whose renderers main never stamps. */
export function readProductUiIdentityArgument(argv: readonly string[]): ProductUiIdentity | null {
  const argument = argv.find((entry) => entry.startsWith(PREFIX))
  if (!argument) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(decodeURIComponent(argument.slice(PREFIX.length)))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const displayName = Reflect.get(value, 'displayName')
  const cliName = Reflect.get(value, 'cliName')
  const stablyServices = Reflect.get(value, 'stablyServices')
  const repositoryUrl = Reflect.get(value, 'repositoryUrl')
  if (
    typeof displayName !== 'string' ||
    typeof cliName !== 'string' ||
    typeof stablyServices !== 'boolean' ||
    (repositoryUrl !== null && typeof repositoryUrl !== 'string')
  ) {
    return null
  }
  return { displayName, cliName, stablyServices, repositoryUrl }
}
