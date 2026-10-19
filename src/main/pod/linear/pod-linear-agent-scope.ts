// Fork-only (Pod): which workspaces an agent's linear.* call may use: those whose current connection
// id is in the agent-access grant (pod-linear-key-record.ts). A workspace connected again after the
// grant has a new id, so agents lose it until the user turns access on again.
import type { LinearWorkspaceFile } from '../../linear/linear-workspace-record'
import { loadToken } from '../../linear/linear-token-store'
import { getWorkspaceState } from '../../linear/linear-workspace-registry'
import { linearAgentAccessConnectionIds } from './pod-linear-agent-access-store'
import { isPodLinearAgentCall } from './pod-linear-call-scope'
import { knownLinearConnectionId } from './pod-linear-key-record'

function connectionIdOf(workspaceId: string): string | null {
  if (knownLinearConnectionId(workspaceId) === undefined) {
    try {
      loadToken({ force: true, workspaceId })
    } catch {
      // A key Pod can't unseal has no connection to grant.
      return null
    }
  }
  return knownLinearConnectionId(workspaceId) ?? null
}

/** The connection ids of every workspace connected now. */
export function currentLinearConnectionIds(): string[] {
  return getWorkspaceState().workspaces.flatMap((workspace) => {
    const connectionId = connectionIdOf(workspace.id)
    return connectionId === null ? [] : [connectionId]
  })
}

/** On while the grant names at least one workspace connected now; no grant reads no key. */
export function isLinearAgentAccessGranted(): boolean {
  const granted = linearAgentAccessConnectionIds()
  return granted.size > 0 && currentLinearConnectionIds().some((id) => granted.has(id))
}

/** False only in an agent's call, for a workspace whose connection the grant doesn't name. */
export function podLinearAgentMayUse(workspaceId: string | null): boolean {
  if (!isPodLinearAgentCall()) {
    return true
  }
  const connectionId = workspaceId === null ? null : connectionIdOf(workspaceId)
  return connectionId !== null && linearAgentAccessConnectionIds().has(connectionId)
}

/** In an agent's call, only the workspaces its grant names; outside one, `state` as is. */
export function podLinearAgentVisibleState(state: LinearWorkspaceFile): LinearWorkspaceFile {
  if (!isPodLinearAgentCall()) {
    return state
  }
  const workspaces = state.workspaces.filter((workspace) => podLinearAgentMayUse(workspace.id))
  const visible = (id: string | null): string | null =>
    workspaces.some((workspace) => workspace.id === id) ? id : null
  return {
    version: 1,
    activeWorkspaceId: visible(state.activeWorkspaceId),
    selectedWorkspaceId:
      state.selectedWorkspaceId === 'all' ? 'all' : visible(state.selectedWorkspaceId),
    workspaces
  }
}
