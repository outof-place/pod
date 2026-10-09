// Fork-only (Pod): renderer view of the downstream product identity; null means upstream Orca.
import { brandProductName, type ProductNameBranding } from '../../../shared/product-name-branding'
import type { ProductUiIdentity } from '../../../shared/product-ui-identity'

let identity: ProductUiIdentity | null | undefined

export function getProductUiIdentity(): ProductUiIdentity | null {
  if (identity === undefined) {
    // Why optional: unit tests and the web client stub only the api slices they use.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    identity = api?.product?.get() ?? null
  }
  return identity
}

/** False only in a product that ships without Stably's hosted services. */
export function areStablyServicesAvailable(): boolean {
  return getProductUiIdentity()?.stablyServices !== false
}

export function getProductNameBranding(): ProductNameBranding | null {
  const product = getProductUiIdentity()
  return product ? { displayName: product.displayName, cliName: product.cliName } : null
}

/** Brands hardcoded renderer copy that never passes through translate(). */
export function brandProductCopy(text: string): string {
  const branding = getProductNameBranding()
  return branding ? brandProductName(text, branding) : text
}

/** The HTML <title> becomes the native window title once the page loads. */
export function brandDocumentTitle(): void {
  const branding = getProductNameBranding()
  if (branding) {
    document.title = brandProductName(document.title, branding)
  }
}

export function _resetProductUiIdentityForTests(): void {
  identity = undefined
}
