// Fork-only (Pod): upstream tests that drive agents' linear.* methods run with agent access on.
import { afterEach, beforeEach } from 'vitest'
import { setPodLinearAgentAccessSetting } from './pod-linear-access'

export function withLinearAgentAccessOn(): void {
  beforeEach(() => setPodLinearAgentAccessSetting({ read: () => true, write: () => {} }))
  afterEach(() => setPodLinearAgentAccessSetting(null))
}
