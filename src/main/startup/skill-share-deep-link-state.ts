import { skillShareIdFromArguments } from '../../shared/skill-share-link'
import { productUrlSchemes } from '../product-identity/product-identity'

export class SkillShareDeepLinkState {
  private pendingShareId: string | null = null

  capture(argv: readonly string[], publish?: (shareId: string) => void): boolean {
    const shareId = skillShareIdFromArguments(argv, productUrlSchemes())
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
