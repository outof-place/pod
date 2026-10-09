// Fork-only (Pod): the opt-in for marketplace, Git and local-folder plugins in a product without
// Stably's plugin kill list. Renders nothing for upstream Orca.
import { translate } from '@/i18n/i18n'
import { areStablyServicesAvailable, getProductUiIdentity } from '@/lib/product-ui-identity'
import { useAppStore } from '@/store'
import { areThirdPartyPluginsAllowed } from '../../../../shared/product-plugin-policy'
import { PluginMarketplaceBrowser } from './PluginMarketplaceBrowser'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

export function useThirdPartyPluginsAllowed(): boolean {
  return useAppStore((state) =>
    areThirdPartyPluginsAllowed(areStablyServicesAvailable(), state.settings)
  )
}

/** The marketplace browser, or only the installed list while third-party plugins are off. */
export function ProductPluginMarketplaceGate(
  props: React.ComponentProps<typeof PluginMarketplaceBrowser>
): React.JSX.Element {
  const allowed = useThirdPartyPluginsAllowed()
  return allowed ? (
    <PluginMarketplaceBrowser {...props} />
  ) : (
    <>{props.renderInstalledContent?.('')}</>
  )
}

export function ProductThirdPartyPluginsSetting(): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.thirdPartyPluginsEnabled === true)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const product = getProductUiIdentity()
  if (!product || product.stablyServices) {
    return null
  }
  return (
    <>
      <SettingsRow
        label={translate(
          'auto.components.settings.ProductThirdPartyPlugins.label',
          'Third-party plugins'
        )}
        labelId="third-party-plugins-label"
        description={translate(
          'auto.components.settings.ProductThirdPartyPlugins.description',
          'Install plugins from marketplaces, Git and local folders. While this is off, only plugins bundled with {{product}} run.',
          { product: product.displayName }
        )}
        alignTop
        control={
          <SettingsSwitch
            checked={enabled}
            ariaLabelledBy="third-party-plugins-label"
            onChange={() => void updateSettings({ thirdPartyPluginsEnabled: !enabled })}
          />
        }
      />
      {enabled ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ProductThirdPartyPlugins.revocationNote',
            "Remote revocation isn't available in {{product}}, so a plugin later found unsafe can't be blocked for you.",
            { product: product.displayName }
          )}
        </p>
      ) : null}
    </>
  )
}
