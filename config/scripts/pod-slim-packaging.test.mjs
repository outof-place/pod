import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { applyPodSlimPackaging } = require('../../product/pod-slim-packaging.cjs')
const projectDir = path.resolve(import.meta.dirname, '../..')

// Why a child process: the slim config edits upstream lists before the upstream config loads,
// which only works in a fresh module cache.
function inspectSlimConfig(profile) {
  const script = `
    const slim = require('./product/electron-builder.slim.cjs')
    const upstream = require('./config/electron-builder.config.cjs')
    const ripgrep = require('./config/bundled-ripgrep-resources.cjs')
    const target = (entry) => (typeof entry === 'string' ? entry : entry.to)
    process.stdout.write(JSON.stringify({
      targets: slim.mac.extraResources.map(target),
      sources: slim.mac.extraResources.map((entry) => (typeof entry === 'string' ? entry : entry.from)),
      ripgrepFilter: slim.mac.extraResources.find((entry) => entry.to === 'ripgrep').filter,
      ripgrepPlatforms: ripgrep.BUNDLED_RIPGREP_PLATFORMS,
      electronLanguages: slim.electronLanguages ?? null,
      sameAfterPack: slim.afterPack === upstream.afterPack,
      mobileWebGuard: require('./config/scripts/verify-packaged-mobile-web-bundle.cjs').assertMobileWebBundleBuilt.name
    }))
  `
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, POD_BUILD_PROFILE: profile }
    })
  )
}

describe('Pod slim packaging', () => {
  it('removes cut packaging only from the macOS app', () => {
    const base = {
      files: ['!src{,/**/*}'],
      mac: {
        extraResources: [
          { from: 'out/relay', to: 'relay' },
          { from: 'resources/onboarding/feature-wall', to: 'onboarding/feature-wall' },
          { from: '/store/serve-sim', to: 'node_modules/serve-sim' },
          'resources/skills'
        ]
      },
      win: { extraResources: [{ from: 'resources/onboarding/feature-wall', to: 'x' }] }
    }
    const slim = applyPodSlimPackaging(base, 'pod')
    expect(slim.files).toEqual([
      '!src{,/**/*}',
      '!out/web{,/**/*}',
      '!out/mobile-web{,/**/*}',
      '!resources/linux{,/**/*}',
      '!cloud{,/**/*}'
    ])
    expect(slim.mac.extraResources).toEqual([
      { from: 'out/relay', to: 'relay', filter: ['**/*', '!win32-*{,/**/*}', '!wsl{,/**/*}'] },
      'resources/skills'
    ])
    expect(slim.electronLanguages).toEqual(['en'])
    expect(slim.win).toBe(base.win)
    expect(applyPodSlimPackaging(base, 'orca')).toEqual(base)
  })

  it('drops cut runtime packages and win32 ripgrep before the upstream config loads', () => {
    const pod = inspectSlimConfig('pod')
    for (const dropped of [
      'node_modules/@linear/sdk',
      'node_modules/serve-sim',
      'node_modules/sonner'
    ]) {
      expect(pod.targets).not.toContain(dropped)
    }
    expect(pod.sources.some((source) => source.includes('sherpa-onnx'))).toBe(false)
    expect(pod.ripgrepPlatforms).toEqual(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])
    expect(pod.ripgrepFilter.some((pattern) => pattern.startsWith('win32-'))).toBe(false)
    expect(pod.electronLanguages).toEqual(['en'])
    expect(pod.sameAfterPack).toBe(true)
    expect(pod.mobileWebGuard).toBe('')

    const orca = inspectSlimConfig('orca')
    expect(orca.targets).toContain('node_modules/@linear/sdk')
    expect(orca.ripgrepPlatforms).toContain('win32-x64')
    expect(orca.electronLanguages).toBeNull()
    expect(orca.mobileWebGuard).toBe('assertMobileWebBundleBuilt')
  })
})
