import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')

// Why a child process: the release config edits upstream lists before the upstream config loads,
// which only works in a fresh module cache.
function inspectReleaseConfig(profile) {
  const script = `
    const pod = require('./product/electron-builder.pod.cjs')
    const runtime = require('./config/packaged-runtime-node-modules.cjs')
    const ripgrep = require('./config/bundled-ripgrep-resources.cjs')
    const entry = (target) => pod.mac.extraResources.find((e) => typeof e !== 'string' && e.to === target)
    process.stdout.write(JSON.stringify({
      files: pod.files,
      targets: pod.mac.extraResources.map((e) => (typeof e === 'string' ? e : e.to)),
      relayFilter: entry('relay').filter ?? null,
      ripgrepFilter: entry('ripgrep').filter,
      ripgrepPlatforms: ripgrep.BUNDLED_RIPGREP_PLATFORMS,
      runtimeRoots: runtime.PACKAGED_RUNTIME_PACKAGE_ROOTS,
      electronLanguages: pod.electronLanguages ?? null,
      platformSections: ['win', 'nsis', 'linux', 'appImage', 'deb', 'rpm'].filter((key) => key in pod)
    }))
  `
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, POD_BUILD_PROFILE: profile },
      // Why: a config read without the claude-acc and pod-search payloads warns on stderr.
      stdio: ['ignore', 'pipe', 'ignore']
    })
  )
}

describe('Pod release packaging (electron-builder.pod.cjs)', () => {
  it('takes the Pod profile packaging cuts from the slim config', () => {
    const pod = inspectReleaseConfig('pod')
    for (const excluded of [
      '!out/web{,/**/*}',
      '!out/mobile-web{,/**/*}',
      '!resources/linux{,/**/*}',
      '!cloud{,/**/*}'
    ]) {
      expect(pod.files).toContain(excluded)
    }
    for (const dropped of [
      'onboarding/feature-wall',
      'node_modules/serve-sim',
      'node_modules/sonner'
    ]) {
      expect(pod.targets).not.toContain(dropped)
    }
    expect(pod.targets.some((target) => target.includes('sherpa-onnx'))).toBe(false)
    expect(pod.relayFilter).toEqual(['**/*', '!win32-*{,/**/*}', '!wsl{,/**/*}'])
    expect(pod.ripgrepFilter.some((pattern) => pattern.startsWith('win32-'))).toBe(false)
    expect(pod.ripgrepPlatforms.some((platform) => platform.startsWith('win32-'))).toBe(false)
    expect(pod.platformSections).toEqual([])
  })

  it('keeps every Chromium locale pak', () => {
    expect(inspectReleaseConfig('pod').electronLanguages).toBeNull()
  })

  it('ships @linear/sdk whatever the linear flag says', () => {
    for (const profile of ['pod', 'orca']) {
      const config = inspectReleaseConfig(profile)
      expect(config.runtimeRoots).toContain('@linear/sdk')
      expect(config.targets).toContain('node_modules/@linear/sdk')
    }
  })

  it('keeps the full upstream packaging for POD_BUILD_PROFILE=orca', () => {
    const orca = inspectReleaseConfig('orca')
    expect(orca.files).not.toContain('!cloud{,/**/*}')
    expect(orca.targets).toContain('onboarding/feature-wall')
    expect(orca.ripgrepPlatforms).toContain('win32-x64')
  })
})
