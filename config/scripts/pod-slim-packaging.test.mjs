import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { applyPodSlimPackaging } = require('../../product/pod-slim-packaging.cjs')
const upstreamConfig = require('../electron-builder.config.cjs')
const slimConfig = require('../../product/electron-builder.slim.cjs')

const fromOf = (entry) => (typeof entry === 'string' ? entry : entry.from)

describe('Pod slim packaging', () => {
  it('removes cut packaging only from the macOS app', () => {
    const base = {
      files: ['!src{,/**/*}'],
      mac: {
        extraResources: [
          { from: 'out/relay', to: 'relay' },
          { from: 'resources/onboarding/feature-wall', to: 'onboarding/feature-wall' },
          'resources/skills'
        ]
      },
      win: { extraResources: [{ from: 'resources/onboarding/feature-wall', to: 'x' }] }
    }
    const slim = applyPodSlimPackaging(base, 'pod')
    expect(slim.files).toEqual(['!src{,/**/*}', '!resources/linux{,/**/*}', '!cloud{,/**/*}'])
    expect(slim.mac.extraResources).toEqual([
      { from: 'out/relay', to: 'relay', filter: ['**/*', '!wsl{,/**/*}'] },
      'resources/skills'
    ])
    expect(slim.win).toBe(base.win)
    expect(applyPodSlimPackaging(base, 'orca')).toEqual(base)
  })

  it('keeps every upstream hook and every non-cut mac resource', () => {
    expect(slimConfig.afterPack).toBe(upstreamConfig.afterPack)
    expect(slimConfig.beforePack).toBe(upstreamConfig.beforePack)
    const kept = slimConfig.mac.extraResources.map(fromOf)
    for (const from of upstreamConfig.mac.extraResources.map(fromOf)) {
      if (from !== 'resources/onboarding/feature-wall') {
        expect(kept).toContain(from)
      }
    }
  })
})
