// Fork-only (Pod): the product overlay's view of product/identity.json. Every hook in an upstream
// file goes through here, and each one is a no-op when the build ships no identity (upstream Orca).
import { getProductIdentity } from './product-identity'
import { isStablyServicesOffByEnv } from '../../shared/stably-services-env'
import { brandProductName, type ProductNameBranding } from '../../shared/product-name-branding'
import {
  formatProductUiIdentityArgument,
  type ProductUiIdentity
} from '../../shared/product-ui-identity'

/** False in a product whose identity ships `"stablyServices": false`, and in the orcad it launches. */
export function areStablyServicesEnabled(): boolean {
  return getProductIdentity()?.stablyServices !== false && !isStablyServicesOffByEnv(process.env)
}

export function productDisplayName(): string {
  return getProductIdentity()?.displayName ?? 'Orca'
}

/** User-facing reason a Stably service refuses to run, e.g. "Feedback is not available in Pod." */
export function stablyServiceUnavailableMessage(service: string): string {
  return `${service} is not available in ${productDisplayName()}.`
}

export class StablyServiceDisabledError extends Error {
  constructor(service: string) {
    super(stablyServiceUnavailableMessage(service))
    this.name = 'StablyServiceDisabledError'
  }
}

export function getProductNameBranding(): ProductNameBranding | null {
  const identity = getProductIdentity()
  return identity ? { displayName: identity.displayName, cliName: identity.cliName } : null
}

/** Brands hardcoded main-process copy that never passes through translateMain(). */
export function brandProductCopy(text: string): string {
  const branding = getProductNameBranding()
  return branding ? brandProductName(text, branding) : text
}

/** Renames upstream copy on a built native notification, so its construction stays upstream's. */
export function brandNotificationCopy(notification: { title: string; body: string }): void {
  if (getProductNameBranding()) {
    notification.title = brandProductCopy(notification.title)
    notification.body = brandProductCopy(notification.body)
  }
}

export function getProductUiIdentity(): ProductUiIdentity | null {
  const identity = getProductIdentity()
  if (!identity) {
    return null
  }
  const feed = identity.updateFeed
  return {
    displayName: identity.displayName,
    cliName: identity.cliName,
    stablyServices: identity.stablyServices,
    repositoryUrl: feed ? `https://github.com/${feed.owner}/${feed.repo}` : null
  }
}

/** Extra `webPreferences.additionalArguments` for app renderers; empty for upstream Orca. */
export function productUiIdentityArguments(): string[] {
  const identity = getProductUiIdentity()
  return identity ? [formatProductUiIdentityArgument(identity)] : []
}

export { productMenuItems } from './product-app-menu'
