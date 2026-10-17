import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

function getHookInspectionTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  hostId?: ExecutionHostId
): ReturnType<typeof getActiveRuntimeTarget> {
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'runtime') {
    return { kind: 'environment', environmentId: parsedHost.environmentId }
  }
  return parsedHost ? { kind: 'local' } : getActiveRuntimeTarget(settings)
}

export type HookCheckResult = {
  status?: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
  /** Pod, on a `ref` read: whether that ref is the repo's own branch. */
  baseOwned?: boolean
}

export type IssueCommandReadResult = {
  status?: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/** `ref` (Pod): that ref's committed orca.yaml, the base a create from it runs. */
export async function checkRuntimeHooks(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId,
  ref?: string
): Promise<HookCheckResult> {
  const target = getHookInspectionTarget(settings, hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.check({
      repoId,
      ...(hostId ? { hostId } : {}),
      ...(ref ? { ref } : {})
    })
  }
  return callRuntimeRpc<HookCheckResult>(
    target,
    'repo.hooksCheck',
    { repo: repoId, ...(ref ? { ref } : {}) },
    { timeoutMs: 15_000 }
  )
}

export async function inspectRuntimeSetupScriptImports(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId
): Promise<SetupScriptImportCandidate[]> {
  const target = getHookInspectionTarget(settings, hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<SetupScriptImportCandidate[]>(
    target,
    'repo.setupScriptImports',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function readRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId
): Promise<IssueCommandReadResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  content: string,
  hostId?: ExecutionHostId
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content, ...(hostId ? { hostId } : {}) })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content },
    { timeoutMs: 15_000 }
  )
}
