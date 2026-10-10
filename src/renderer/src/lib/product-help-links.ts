// Fork-only (Pod): help-menu destinations. A product without Stably's services drops Orca's docs,
// community and feedback endpoints and points at its own repository instead.
import { isStablyHostedUrl } from '../../../shared/stably-hosted-url'
import { getProductUiIdentity } from './product-ui-identity'

export type ProductHelpLinks = {
  docs: string | null
  changelog: string | null
  github: string | null
  discord: string | null
  x: string | null
  /** In-app feedback posts to Stably's onorca.dev. */
  feedback: boolean
}

export function resolveProductHelpLinks(
  upstream: Omit<ProductHelpLinks, 'feedback'>
): ProductHelpLinks {
  const product = getProductUiIdentity()
  if (!product || product.stablyServices) {
    return { ...upstream, feedback: true }
  }
  const repository = product.repositoryUrl
  return {
    // Why: pod/decouple rewrites docs to the product's site; a bare branch still points at Stably's.
    docs: upstream.docs && !isStablyHostedUrl(upstream.docs) ? upstream.docs : null,
    changelog: repository ? `${repository}/releases` : null,
    github: repository,
    discord: null,
    x: null,
    feedback: false
  }
}
