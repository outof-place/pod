import { workspaceCloneParent } from './workspace-clone-destination'
import {
  hasBlockingRootIssue,
  validateWorkspaceRoot,
  type RootValidationDeps
} from './workspace-root-validation'

export type WorkspaceCloneParentDeps = {
  isEnabled: () => boolean
  getRootSetting: () => string
  validation: RootValidationDeps
}

/** Parent folder a clone of `url` goes to; null leaves Orca's own default in place. */
export async function resolveWorkspaceCloneDestination(
  deps: WorkspaceCloneParentDeps,
  url: string
): Promise<string | null> {
  if (!deps.isEnabled()) {
    return null
  }
  const validation = await validateWorkspaceRoot(deps.getRootSetting(), deps.validation)
  // Why null on a refused root: Orca's own default is better than a clone into iCloud.
  if (hasBlockingRootIssue(validation) || !validation.root) {
    return null
  }
  // Before a URL is typed the field shows the root itself.
  return url.trim() ? workspaceCloneParent(validation.root, url) : validation.root
}
