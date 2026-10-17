import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunContent } from './automation-run-content'

const run = (overrides: Partial<AutomationRun>): AutomationRun => ({
  id: 'run-1',
  automationId: 'auto-1',
  title: 'Nightly',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'scheduled',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1,
  ...overrides
})

describe('automation run content (Pod)', () => {
  it('puts a skipped setup’s notice above what the run printed', () => {
    const setupNotice = 'setup skipped: base is outside your branches'
    expect(getAutomationRunContent(run({ setupNotice }))).toBe(
      `${setupNotice}\n\nNo output content available.`
    )
    expect(getAutomationRunContent(run({ error: 'agent exited' }))).toBe('agent exited')
  })
})
