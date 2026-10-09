// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductUiIdentity } from '../../../../shared/product-ui-identity'
import { _resetProductUiIdentityForTests } from '@/lib/product-ui-identity'

const mocks = vi.hoisted(() => {
  const settings: { thirdPartyPluginsEnabled?: boolean } = { thirdPartyPluginsEnabled: false }
  return { settings, updateSettings: vi.fn() }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { product?: string }) =>
    fallback.replace('{{product}}', options?.product ?? '')
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: mocks.settings, updateSettings: mocks.updateSettings })
}))
vi.mock('./PluginMarketplaceBrowser', () => ({
  PluginMarketplaceBrowser: () => <div>Marketplace browser</div>
}))

import {
  ProductPluginMarketplaceGate,
  ProductThirdPartyPluginsSetting
} from './ProductThirdPartyPluginsSetting'

const POD: ProductUiIdentity = {
  displayName: 'Pod',
  cliName: 'podx',
  stablyServices: false,
  repositoryUrl: null
}

function stampProduct(product: ProductUiIdentity | null): void {
  Object.assign(window, { api: { product: { get: () => product } } })
  _resetProductUiIdentityForTests()
}

function renderPluginsSettings(): void {
  render(
    <>
      <ProductThirdPartyPluginsSetting />
      <ProductPluginMarketplaceGate
        installedPlugins={[]}
        onInstalled={vi.fn()}
        renderInstalledContent={() => <div>Installed plugins</div>}
      />
    </>
  )
}

describe('third-party plugin opt-in', () => {
  beforeEach(() => {
    mocks.settings.thirdPartyPluginsEnabled = false
    mocks.updateSettings.mockReset()
  })

  afterEach(() => {
    cleanup()
    stampProduct(null)
  })

  it('keeps the upstream marketplace and shows no opt-in', () => {
    stampProduct(null)
    renderPluginsSettings()
    expect(screen.getByText('Marketplace browser')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('shows only installed plugins until the user opts in', async () => {
    stampProduct(POD)
    renderPluginsSettings()
    expect(screen.getByText('Installed plugins')).toBeInTheDocument()
    expect(screen.queryByText('Marketplace browser')).not.toBeInTheDocument()
    expect(screen.queryByText(/Remote revocation/)).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('switch', { name: 'Third-party plugins' }))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ thirdPartyPluginsEnabled: true })
  })

  it('notes that remote revocation is unavailable once opted in', () => {
    stampProduct(POD)
    mocks.settings.thirdPartyPluginsEnabled = true
    renderPluginsSettings()
    expect(screen.getByText('Marketplace browser')).toBeInTheDocument()
    expect(
      screen.getByText(
        "Remote revocation isn't available in Pod, so a plugin later found unsafe can't be blocked for you."
      )
    ).toBeInTheDocument()
  })
})
