// Fork-only (Pod): who may call which linear.* method, checked once at RPC admission for every
// transport. The key and the workspace choice change only from Pod's own window or from PodNative,
// verified by its audit token: not from a paired device, a phone, an SSH host, or the owner token
// alone, which the CLI and so every agent in a Pod terminal holds. Agents' methods answer only while
// the user has turned on podLinearAgentAccess, which only those same two callers can change.
import type { RpcCallerIdentity } from '../../runtime/rpc/rpc-caller-identity'
import type { RpcCallerScope } from '../../runtime/rpc/rpc-caller-scope'

export const POD_LINEAR_SET_AGENT_ACCESS = 'linear.setAgentAccess'

/** Methods that set or remove a key, pick the workspace, or let agents in. */
export const POD_LINEAR_ADMIN_METHODS: ReadonlySet<string> = new Set([
  'linear.connect',
  'linear.disconnect',
  'linear.selectWorkspace',
  POD_LINEAR_SET_AGENT_ACCESS
])

/** What the orca CLI, MCP and the SSH bridge call for agents (linear-agent-access.ts, list-issues). */
export const POD_LINEAR_AGENT_METHODS: ReadonlySet<string> = new Set([
  'linear.saveIssue',
  'linear.agentSearchIssues',
  'linear.issueContext',
  'linear.agentTeamList',
  'linear.agentTeamMembers',
  'linear.agentTeamStates',
  'linear.agentTeamLabels',
  'linear.agentIssueList',
  'linear.agentProjectList',
  'linear.resolveCurrentIssue',
  'linear.issueSetState',
  'linear.issueUpdateTask',
  'linear.issueRelationWrite',
  'linear.issueAddComment',
  'linear.issueAttachLink',
  'linear.issueCreate',
  'linear.mcpListIssues'
])

export type PodLinearAccessCaller = {
  scope: RpcCallerScope
  identity: RpcCallerIdentity | undefined
  podNativePeer?: () => { ok: boolean }
}

export type PodLinearRefusal = { code: 'forbidden' | 'linear_unavailable'; message: string }

export type PodLinearAgentAccessSetting = { read(): boolean; write(enabled: boolean): void }

let agentAccessSetting: PodLinearAgentAccessSetting | null = null

/** Installed at startup over the settings store; until then agent access reads as off. */
export function setPodLinearAgentAccessSetting(setting: PodLinearAgentAccessSetting | null): void {
  agentAccessSetting = setting
}

export function isPodLinearAgentAccessOn(): boolean {
  return agentAccessSetting?.read() === true
}

/** Writes the setting and returns what it reads back. */
export function writePodLinearAgentAccess(enabled: boolean): boolean {
  if (!agentAccessSetting) {
    throw new Error('Linear agent access has no settings store yet.')
  }
  agentAccessSetting.write(enabled)
  return isPodLinearAgentAccessOn()
}

function isPodWindowOrPodNative(caller: PodLinearAccessCaller): boolean {
  if (caller.scope.kind !== 'owner') {
    return false
  }
  return caller.identity?.kind === 'desktop' || caller.podNativePeer?.().ok === true
}

/** Null when the caller may invoke the method; any non-Linear method passes. */
export function podLinearRpcRefusal(
  method: string,
  caller: PodLinearAccessCaller
): PodLinearRefusal | null {
  if (POD_LINEAR_ADMIN_METHODS.has(method) && !isPodWindowOrPodNative(caller)) {
    return {
      code: 'forbidden',
      message: `${method} is available only in Pod's own window or PodNative on this Mac.`
    }
  }
  if (POD_LINEAR_AGENT_METHODS.has(method) && !isPodLinearAgentAccessOn()) {
    return {
      code: 'linear_unavailable',
      message:
        "Linear is off for agents. The user can turn on agent access in Pod's Linear settings."
    }
  }
  return null
}
