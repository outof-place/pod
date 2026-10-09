import type { ProductIdentity } from './product-identity'

/** A downstream product shipped without Stably's hosted services, as product/identity.json does. */
export function podIdentityWithoutStablyServices(): ProductIdentity {
  return {
    displayName: 'Pod',
    appId: 'codes.pod.app',
    packageName: 'pod',
    cliName: 'podx',
    userDataName: 'Pod',
    keychainName: 'Pod',
    protocols: ['pod'],
    homepage: 'https://pod.codes',
    updateFeed: { provider: 'github', owner: 'outof-place', repo: 'pod' },
    copyright: 'Copyright © 2026 outofplace',
    credits: 'Built on Orca by Stably AI, MIT. Not affiliated.',
    stablyServices: false,
    computerUseDisplayName: null,
    legacyProfile: null
  }
}
