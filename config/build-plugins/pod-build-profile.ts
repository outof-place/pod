// Fork-only (Pod): compiles the Pod feature profile (src/shared/product/features.ts) into every
// electron-vite target, so code behind a false flag is dead and tree-shaken out.
import type { UserConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import {
  podFeatureDefines,
  podStubModules,
  type PodBuildProfile
} from '../../src/shared/product/features'

export function readPodBuildProfile(env: NodeJS.ProcessEnv = process.env): PodBuildProfile {
  return env.POD_BUILD_PROFILE === 'orca' ? 'orca' : 'pod'
}

function createPodStubModulesPlugin(patterns: readonly RegExp[]): Plugin {
  return {
    name: 'pod-stub-modules',
    enforce: 'pre',
    load(id) {
      if (!patterns.some((pattern) => pattern.test(id.split('?')[0]))) {
        return null
      }
      // Why: Vite's JSON plugin still transforms a .json id, so it must stay valid JSON.
      return id.split('?')[0].endsWith('.json') ? '{}' : 'export default {}'
    }
  }
}

export function withPodBuildProfile(
  config: UserConfig,
  profile: PodBuildProfile = readPodBuildProfile()
): UserConfig {
  const define = podFeatureDefines(profile)
  const stubs = podStubModules(profile)
  // Why in place: config/scripts tests import the exported electronViteConfig object itself.
  for (const target of [config.main, config.preload, config.renderer]) {
    if (target) {
      target.define = { ...target.define, ...define }
      if (stubs.length > 0) {
        target.plugins = [createPodStubModulesPlugin(stubs), ...(target.plugins ?? [])]
      }
    }
  }
  return config
}
