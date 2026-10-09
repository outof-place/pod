import type { ProductUiIdentity } from '../../shared/product-ui-identity'

export type ProductApi = {
  /** Fork-only (Pod): the downstream product this renderer runs in; null for upstream Orca. */
  get: () => ProductUiIdentity | null
}
