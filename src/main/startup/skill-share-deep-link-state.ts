import { skillShareIdFromArguments } from '../../shared/skill-share-link'
import { productUrlSchemes } from '../product-identity/product-identity'
import { areStablyServicesEnabled } from '../product-identity/product-overlay'

export class SkillShareDeepLinkState {
  private pendingShareId: string | null = null

  capture(argv: readonly string[], publish?: (shareId: string) => void): boolean {
    // Fork-only (Pod): shared skills are served by Stably's app.orca.dev.
    const shareId = areStablyServicesEnabled()
      ? skillShareIdFromArguments(argv, productUrlSchemes())
      : null
    if (!shareId) {
      return false
    }
    this.pendingShareId = shareId
    publish?.(shareId)
    return true
  }

  consume(): string | null {
    const shareId = this.pendingShareId
    this.pendingShareId = null
    return shareId
  }
}
