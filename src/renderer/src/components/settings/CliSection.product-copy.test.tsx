// @vitest-environment happy-dom
// Fork-only (Pod): with no status detail, the shell command row names the product's command.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProductUiIdentity } from '../../../../shared/product-ui-identity'
import { _resetProductUiIdentityForTests } from '@/lib/product-ui-identity'
import { CliSection } from './CliSection'

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ canUseLocalSkillFreshness: true })
}))
vi.mock('./AgentSkillSetupPanel', () => ({ AgentSkillSetupPanel: () => null }))
vi.mock('./CliRegistrationDialog', () => ({ CliRegistrationDialog: () => null }))
vi.mock('./WslCliRegistration', () => ({ WslCliRegistration: () => null }))

const POD: ProductUiIdentity = {
  displayName: 'Pod',
  cliName: 'podx',
  stablyServices: false,
  repositoryUrl: null
}

function stampApi(product: ProductUiIdentity | null): void {
  Object.assign(window, {
    api: {
      product: { get: () => product },
      cli: {
        // A status without detail: the row falls back to its own description.
        getInstallStatus: vi.fn().mockResolvedValue({
          platform: 'darwin',
          supported: true,
          state: 'not_installed',
          pathConfigured: true,
          detail: null
        }),
        getWslInstallStatus: vi.fn(),
        install: vi.fn(),
        remove: vi.fn()
      },
      shell: { openPath: vi.fn() }
    }
  })
  _resetProductUiIdentityForTests()
}

afterEach(() => {
  cleanup()
  _resetProductUiIdentityForTests()
})

describe('CliSection product copy', () => {
  it("names the product's command when the status has no detail", async () => {
    stampApi(POD)
    render(<CliSection currentPlatform="darwin" settings={getDefaultSettings('/tmp')} />)
    expect(await screen.findByText('Register `podx` in /usr/local/bin.')).toBeDefined()
  })

  it("keeps upstream's command without a product", async () => {
    stampApi(null)
    render(<CliSection currentPlatform="darwin" settings={getDefaultSettings('/tmp')} />)
    expect(await screen.findByText('Register `orca` in /usr/local/bin.')).toBeDefined()
  })
})
