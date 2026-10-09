// Fork-only (Pod): compiles the Pod feature profile (src/shared/product/features.ts) into every
// electron-vite target, so code behind a false flag is dead and tree-shaken out.
import type { UserConfig } from 'electron-vite'
import { podFeatureDefines, type PodBuildProfile } from '../../src/shared/product/features'

export function readPodBuildProfile(env: NodeJS.ProcessEnv = process.env): PodBuildProfile {
  return env.POD_BUILD_PROFILE === 'orca' ? 'orca' : 'pod'
}

export function withPodBuildProfile(
  config: UserConfig,
  profile: PodBuildProfile = readPodBuildProfile()
): UserConfig {
  const define = podFeatureDefines(profile)
  // Why in place: config/scripts tests import the exported electronViteConfig object itself.
  for (const target of [config.main, config.preload, config.renderer]) {
    if (target) {
      target.define = { ...target.define, ...define }
    }
  }
  return config
}
