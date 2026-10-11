// Fork-only (Pod): the packaged CLI runs under ELECTRON_RUN_AS_NODE with the app's resourcesPath,
// so it sees the app's product identity; dev and upstream launches see none.
import { getProductIdentity } from '../main/product-identity/product-identity'
import { brandProductName } from '../shared/product-name-branding'
import { productHelperCopyFor } from '../shared/product-helper-names'

export function brandCliHelp(text: string): string {
  const identity = getProductIdentity()
  return identity
    ? brandProductName(text, { displayName: identity.displayName, cliName: identity.cliName })
    : text
}

/** Upstream copy naming a bundled helper, with the product's helper names. */
export function cliProductHelperCopy(text: string): string {
  return productHelperCopyFor(getProductIdentity(), text)
}
