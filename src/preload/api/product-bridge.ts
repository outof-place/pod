import { readProductUiIdentityArgument } from '../../shared/product-ui-identity'
import type { PreloadApi } from '../api-types'

let identity: ReturnType<PreloadApi['product']['get']> | undefined

export const productApi = {
  get: () =>
    identity === undefined ? (identity = readProductUiIdentityArgument(process.argv)) : identity
} satisfies PreloadApi['product']
