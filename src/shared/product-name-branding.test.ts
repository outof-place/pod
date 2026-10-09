import { describe, expect, it } from 'vitest'
import { brandProductCatalog, brandProductName } from './product-name-branding'

const pod = { displayName: 'Pod', cliName: 'podx' }

describe('brandProductName', () => {
  it('renames the product, its possessive, compounds and the uppercase logo', () => {
    expect(brandProductName("Restart Orca to apply Orca's new Orca-managed setting.", pod)).toBe(
      "Restart Pod to apply Pod's new Pod-managed setting."
    )
    expect(brandProductName('ORCA', pod)).toBe('POD')
  })

  it('fixes the indefinite article for the new name', () => {
    expect(brandProductName('Open an Orca worktree. An Orca host is ready.', pod)).toBe(
      'Open a Pod worktree. A Pod host is ready.'
    )
    expect(brandProductName('an Orca host', { displayName: 'Ark', cliName: 'ark' })).toBe(
      'an Ark host'
    )
  })

  it('renames the shell command only where it is the command', () => {
    expect(brandProductName('Created via `orca worktree create`', pod)).toBe(
      'Created via `podx worktree create`'
    )
    expect(brandProductName('Registered `orca` in PATH.', pod)).toBe('Registered `podx` in PATH.')
    expect(brandProductName("Allow this host's orca CLI", pod)).toBe("Allow this host's podx CLI")
    for (const literal of [
      'orca.yaml',
      'orca://pair',
      '~/.orca/keys',
      'https://example.com/orca',
      'acme/orca-notes',
      '/orca-linear',
      'ORCA_TELEMETRY_DISABLED',
      'github.com/stablyai/orca',
      'onorca.dev'
    ]) {
      expect(brandProductName(literal, pod)).toBe(literal)
    }
  })

  it('keeps copy that names upstream services or credits Orca', () => {
    for (const phrase of [
      'Connect an Orca Cloud account',
      'Orca Relay is in beta.',
      'Scan with Orca Mobile',
      'Your Orca account session expired.',
      'Star Orca on GitHub',
      'Support Orca',
      'Built on Orca by Stably'
    ]) {
      expect(brandProductName(phrase, pod)).toBe(phrase)
    }
    expect(brandProductName('Sign in to extend Orca with Orca Relay.', pod)).toBe(
      'Sign in to extend Pod with Orca Relay.'
    )
  })

  it('leaves interpolation placeholders alone', () => {
    expect(brandProductName('Orca {{value0}} needs {{orcaVersion}}', pod)).toBe(
      'Pod {{value0}} needs {{orcaVersion}}'
    )
  })
})

describe('brandProductCatalog', () => {
  it('brands nested leaves without mutating the source catalog', () => {
    const catalog = { menu: { exploreOrca: 'Explore Orca', count: 2 }, list: ['Orca'] }
    expect(brandProductCatalog(catalog, pod)).toEqual({
      menu: { exploreOrca: 'Explore Pod', count: 2 },
      list: ['Pod']
    })
    expect(catalog.menu.exploreOrca).toBe('Explore Orca')
  })
})
