/**
 * Fork-only (Pod): every English string the renderer can show, rendered through translate() the
 * way a product renderer runs it, names the product instead of Orca. The only "Orca" left is copy
 * about upstream on purpose: Stably's services (hidden in Pod) and credit or support for Orca.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { UPSTREAM_PRODUCT_PHRASE } from '../../../shared/product-name-branding'
import type { ProductUiIdentity } from '../../../shared/product-ui-identity'
import en from './locales/en.json'

vi.hoisted(() => {
  const pod: ProductUiIdentity = {
    displayName: 'Pod',
    cliName: 'podx',
    stablyServices: false,
    repositoryUrl: 'https://github.com/outof-place/pod'
  }
  Object.assign(globalThis, { window: { api: { product: { get: () => pod } } } })
})

import { translate } from './i18n'

function flatten(value: unknown, prefix = '', entries = new Map<string, string>()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, entries)
    }
  }
  return entries
}

const PRODUCT_NAME = /\bOrca\b|\bORCA\b/

describe('rendered English copy in a product build', () => {
  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  const rendered = [...flatten(en)].map(([key, value]) => ({
    key,
    source: value,
    // Why a fallback equal to the catalog value: that is what every translate() call site passes.
    text: translate(key, value)
  }))

  it('names the product everywhere except allowlisted upstream phrases', () => {
    const leaks = rendered
      .filter(({ text }) => PRODUCT_NAME.test(text.replace(UPSTREAM_PRODUCT_PHRASE, '')))
      .map(({ key, text }) => `${key}: ${text}`)
    expect(leaks).toEqual([])
    expect(rendered.filter(({ source, text }) => source !== text).length).toBeGreaterThan(700)
  })

  it('keeps Stably services and Orca credit copy as upstream wrote it', () => {
    const kept = new Set(rendered.flatMap(({ text }) => text.match(UPSTREAM_PRODUCT_PHRASE) ?? []))
    expect([...kept].every((phrase) => phrase.includes('Orca'))).toBe(true)
    expect(kept).toContain('Star Orca')
    expect(kept).toContain('Orca Relay')
  })

  it('renames the CLI without touching identifiers or interpolated values', () => {
    expect(
      translate(
        'auto.components.sidebar.WorktreeCardMeta.cliCreatedFromShell',
        'Created via `orca worktree create`'
      )
    ).toBe('Created via `podx worktree create`')
    expect(
      translate('test.product.interpolation', 'Open {{name}} in Orca', { name: 'Orca Notes' })
    ).toBe('Open Orca Notes in Pod')
    for (const { source, text } of rendered) {
      for (const literal of ['orca.yaml', 'orca://', 'ORCA_']) {
        expect(text.split(literal).length).toBe(source.split(literal).length)
      }
    }
  })
})
