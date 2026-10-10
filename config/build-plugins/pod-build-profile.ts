// Fork-only (Pod): compiles the Pod feature profile (src/shared/product/features.ts) into every
// electron-vite target, so code behind a false flag is dead and tree-shaken out.
import type { UserConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { basename } from 'node:path'
import {
  podFeatureDefines,
  podRendererFontSwaps,
  podStubModules,
  type PodBuildProfile,
  type PodFontSwap
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type EmittedFile = { type: string; fileName: string; source?: string | Uint8Array }

// Why on the emitted CSS: Tailwind inlines main.css's @imports from disk, so a transform never
// sees rich-markdown-editor.css; the bundle is also where the dropped face's font file lives.
// Throws when a face or its file is missing: a rename would otherwise ship the font again.
export function swapPodFontFaces(
  bundle: Record<string, EmittedFile>,
  swaps: readonly PodFontSwap[]
): void {
  for (const swap of swaps) {
    const family = `["']?${escapeRegExp(swap.family)}["']?`
    const face = new RegExp(
      `@font-face\\s*\\{[^}]*?font-family:\\s*${family}\\s*(?:;[^}]*)?\\}`,
      'g'
    )
    const listed = new RegExp(`(?<=[:,(]\\s*)${family}(?=\\s*[,;)}!])`, 'g')
    const fontFiles = new Set<string>()
    let dropped = false
    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset' || !output.fileName.endsWith('.css') || !output.source) {
        continue
      }
      const css =
        typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)
      const withoutFace = css.replace(face, (block) => {
        dropped = true
        for (const match of block.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
          // Why skip data: URLs: an inlined face has no file left to drop.
          if (!match[1].startsWith('data:')) {
            fontFiles.add(basename(match[1].split(/[?#]/)[0]))
          }
        }
        return ''
      })
      output.source = withoutFace.replace(listed, swap.to)
    }
    if (!dropped) {
      throw new Error(`pod-font-swaps: no @font-face for ${swap.family} in the renderer CSS`)
    }
    for (const file of fontFiles) {
      const key = Object.keys(bundle).find((fileName) => basename(fileName) === file)
      if (!key) {
        throw new Error(`pod-font-swaps: ${swap.family} face file ${file} is not in the bundle`)
      }
      delete bundle[key]
    }
  }
}

function createPodFontSwapPlugin(swaps: readonly PodFontSwap[]): Plugin {
  return {
    name: 'pod-font-swaps',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      try {
        swapPodFontFaces(bundle, swaps)
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

export function withPodBuildProfile(
  config: UserConfig,
  profile: PodBuildProfile = readPodBuildProfile()
): UserConfig {
  const define = podFeatureDefines(profile)
  const stubs = podStubModules(profile)
  const fontSwaps = podRendererFontSwaps(profile)
  // Why in place: config/scripts tests import the exported electronViteConfig object itself.
  for (const target of [config.main, config.preload, config.renderer]) {
    if (target) {
      target.define = { ...target.define, ...define }
      if (stubs.length > 0) {
        target.plugins = [createPodStubModulesPlugin(stubs), ...(target.plugins ?? [])]
      }
    }
  }
  if (config.renderer && fontSwaps.length > 0) {
    config.renderer.plugins = [
      ...(config.renderer.plugins ?? []),
      createPodFontSwapPlugin(fontSwaps)
    ]
  }
  return config
}
