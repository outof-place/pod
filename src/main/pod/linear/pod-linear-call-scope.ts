// Fork-only (Pod): marks the RPC calls agents make (POD_LINEAR_AGENT_METHODS), so the Linear client
// holds them to the workspaces agent access names (pod-linear-agent-scope.ts). Pod's window and
// PodNative call other methods and see every workspace.
import { AsyncLocalStorage } from 'node:async_hooks'
import { POD_LINEAR_AGENT_METHODS } from './pod-linear-access'

const agentCall = new AsyncLocalStorage<true>()

export function runInPodLinearCallScope<T>(method: string, run: () => T): T {
  return POD_LINEAR_AGENT_METHODS.has(method) ? agentCall.run(true, run) : run()
}

export function isPodLinearAgentCall(): boolean {
  return agentCall.getStore() === true
}
