// Fork-only (Pod): upstream tests that drive linear.* methods run with Linear on, and those that
// drive agents' methods with agent access on too.
import { afterEach, beforeEach } from 'vitest'
import { setPodLinearAgentAccessSetting } from './pod-linear-access'
import { setPodLinearEnabledSetting } from './pod-linear-availability'

export function withLinearOn(): void {
  beforeEach(() => setPodLinearEnabledSetting({ read: () => true, write: () => {} }))
  afterEach(() => setPodLinearEnabledSetting(null))
}

export function withLinearAgentAccessOn(): void {
  withLinearOn()
  beforeEach(() => setPodLinearAgentAccessSetting({ read: () => true, write: () => {} }))
  afterEach(() => setPodLinearAgentAccessSetting(null))
}

/** For tests that import Linear's modules fresh after vi.resetModules(): Linear on in that graph. */
export async function turnLinearOnInFreshModules(): Promise<void> {
  const availability = await import('./pod-linear-availability')
  availability.setPodLinearEnabledSetting({ read: () => true, write: () => {} })
}
