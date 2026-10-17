import type { RuntimeAutomationUpdateInput } from './runtime-automation-controller'

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}

/** The fields an update copies onto the stored automation when they carry a value. Kept here, out
 *  of the controller, which sits at the max-lines limit. `setupTrustHash` is Pod's. */
export const RUNTIME_AUTOMATION_UPDATE_KEYS = [
  'name',
  'prompt',
  'precheck',
  'agentId',
  'extraAgentArgs',
  'runContext',
  'sourceContext',
  'baseBranch',
  'setupDecision',
  'setupTrustHash',
  'reuseSession',
  'timezone',
  'rrule',
  'dtstart',
  'enabled',
  'missedRunGraceMinutes'
] as const
