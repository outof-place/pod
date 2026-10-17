// Fork-only (Pod): podWorkspace.setRoot, Pod's Settings › Workspace root field as runtime RPC.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PodWorkspaceSetRootResult } from '../../../shared/pod-workspace-types'
import { WorkspacePlanError } from './workspace-plan-store'
import { resolveWorkspaceRoot } from './workspace-root-path'
import { validateWorkspaceRoot, type RootValidationDeps } from './workspace-root-validation'

export type WorkspaceRootSettingDeps = {
  validation: RootValidationDeps
  home: string
  getSettings(): GlobalSettings
  updateSettings(updates: Partial<GlobalSettings>, options: { notifyListeners: boolean }): unknown
}

/**
 * Saves the root after the checks validateRoot runs, refusing on any error as the settings field
 * does. Blank or null is the default, which a fresh Pod has before its first clone makes the
 * folder. Nothing moves: repos outside the new root show as outside, and Move In is per repo.
 */
export async function setWorkspaceRoot(
  value: string | null,
  deps: WorkspaceRootSettingDeps
): Promise<PodWorkspaceSetRootResult> {
  const next = value?.trim() ?? ''
  if (next) {
    const validation = await validateWorkspaceRoot(next, deps.validation)
    const errors = validation.issues.filter((issue) => issue.severity === 'error')
    if (errors.length > 0) {
      throw new WorkspacePlanError(`Not set: ${errors.map((issue) => issue.code).join(', ')}`)
    }
  }
  // With listeners, as settings:set writes: the root sync and every window hear of it.
  deps.updateSettings({ podWorkspaceRoot: next }, { notifyListeners: true })
  return { root: next, resolvedRoot: resolveWorkspaceRoot(deps.getSettings(), deps.home) }
}
