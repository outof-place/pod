import {
  getProductIdentity,
  type ProductIdentity,
  type ProductUpdateFeed
} from '../product-identity/product-identity'
import { isOfficialUpdateFeedDisabled } from './official-update-opt-out'
import { isPodUiHostLaunch } from '../pod/ui-host/pod-ui-host-launch'

export type UpdateFeedPolicy =
  | { kind: 'official' }
  | { kind: 'disabled' }
  // A downstream product updates from its own GitHub releases and never contacts the official feed.
  | { kind: 'product'; feed: ProductUpdateFeed }

export function resolveUpdateFeedPolicy(
  identity: Pick<ProductIdentity, 'updateFeed'> | null,
  officialUpdatesOptedOut: boolean
): UpdateFeedPolicy {
  if (identity?.updateFeed) {
    return { kind: 'product', feed: identity.updateFeed }
  }
  return identity || officialUpdatesOptedOut ? { kind: 'disabled' } : { kind: 'official' }
}

let cached: UpdateFeedPolicy | undefined

export function getUpdateFeedPolicy(): UpdateFeedPolicy {
  // Fork-only (Pod): in the one-app layout Squirrel.Mac would replace the nested runtime, not Pod.app.
  cached ??= isPodUiHostLaunch()
    ? { kind: 'disabled' }
    : resolveUpdateFeedPolicy(getProductIdentity(), isOfficialUpdateFeedDisabled())
  return cached
}
