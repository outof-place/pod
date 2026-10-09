import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../main/product-identity/product-identity'
import type { ProductIdentity } from '../main/product-identity/product-identity'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../main/product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { printHelp } from './help'
import { COMMAND_SPECS } from './specs'

// Inline: the CLI project cannot compile main's test fixtures.
const POD: ProductIdentity = {
  displayName: 'Pod',
  appId: 'codes.pod.app',
  packageName: 'pod',
  cliName: 'podx',
  userDataName: 'Pod',
  keychainName: 'Pod',
  protocols: ['pod'],
  homepage: null,
  updateFeed: null,
  copyright: 'Copyright © 2026 outofplace',
  credits: 'Built on Orca',
  stablyServices: false,
  computerUseDisplayName: null,
  legacyProfile: null
}

function capturedHelp(commandPath: string[]): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  printHelp(COMMAND_SPECS, commandPath)
  const text = log.mock.calls.map((call) => String(call[0])).join('\n')
  log.mockRestore()
  return text
}

describe('CLI help in a product build', () => {
  afterEach(() => {
    identity.current = null
  })

  it('names the upstream command when the app ships no identity', () => {
    expect(capturedHelp([])).toContain('Usage: orca <command>')
  })

  it('names the product command and keeps repository identifiers', () => {
    identity.current = POD
    const root = capturedHelp([])
    expect(root).toContain('Usage: podx <command>')
    expect(root).not.toMatch(/(^|\s|`)orca\s/m)
    expect(capturedHelp(['project', 'setups'])).toContain(
      '$ podx project setups --project github:stablyai/orca'
    )
  })
})
