// The packaging side of pod-sim (product/helper-names.cjs): where it goes in the app, and the
// identifier its signature must carry, against what the runtime and the viewers expect.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { simHelperCandidates } from './sim-helper-path'

const require = createRequire(import.meta.url)
const helperNames: unknown = require('../../../../../product/helper-names.cjs')
const field = (name: string): unknown => Reflect.get(Object(helperNames), name)
const POD_SIM = Object(field('POD_SIM'))
const podSimSignOptions = field('podSimSignOptions')
const podSimSignatureProblems = field('podSimSignatureProblems')
const podSimBuildEnv = field('podSimBuildEnv')

// What `codesign -d --verbose=2` prints for a hardened Developer ID signature.
const SIGNED = [
  'Executable=/A/Pod.app/Contents/Resources/bin/pod-sim',
  'Identifier=codes.pod.sim',
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=9500 flags=0x10000(runtime) hashes=286+7 location=embedded',
  'Authority=Developer ID Application: Filip Maszota (75Y2KR6P5W)',
  'TeamIdentifier=75Y2KR6P5W'
].join('\n')

describe('pod-sim in the packaged app', () => {
  it('is placed where a packaged runtime looks for it, and nowhere else', () => {
    const app = '/Applications/Pod.app'
    expect(
      simHelperCandidates({ packaged: true, resourcesPath: join(app, 'Contents', 'Resources') })
    ).toEqual([join(app, POD_SIM.path)])
  })

  it('is signed under codes.pod.sim, the identifier viewers admit; other files keep their options', () => {
    if (typeof podSimSignOptions !== 'function') {
      throw new Error('podSimSignOptions is not exported')
    }
    const app = '/A/Pod.app'
    const forFile = podSimSignOptions(app, (file: string) => ({
      hardenedRuntime: true,
      additionalArguments: file.endsWith('pod-sim') ? ['--timestamp'] : undefined
    }))
    expect(POD_SIM.identifier).toBe('codes.pod.sim')
    expect(forFile(join(app, POD_SIM.path))).toEqual({
      hardenedRuntime: true,
      additionalArguments: ['--timestamp', '--identifier', 'codes.pod.sim']
    })
    expect(forFile(join(app, 'Contents', 'MacOS', 'Pod'))).toEqual({
      hardenedRuntime: true,
      additionalArguments: undefined
    })
  })

  it('a signature under the file name or without the hardened runtime is refused', () => {
    if (typeof podSimSignatureProblems !== 'function') {
      throw new Error('podSimSignatureProblems is not exported')
    }
    expect(podSimSignatureProblems(SIGNED)).toEqual([])
    expect(
      podSimSignatureProblems(SIGNED.replace('Identifier=codes.pod.sim', 'Identifier=pod-sim'))
    ).toEqual(['its identifier is not codes.pod.sim'])
    expect(
      podSimSignatureProblems(SIGNED.replace('flags=0x10000(runtime)', 'flags=0x0(none)'))
    ).toEqual(['it is not signed with the hardened runtime'])
  })

  it('is built with the Xcode the release runs under, not the one release.sh names for the app icon', () => {
    if (typeof podSimBuildEnv !== 'function') {
      throw new Error('podSimBuildEnv is not exported')
    }
    const xcode27 = '/Applications/Xcode.app/Contents/Developer'
    const xcode26 = '/Applications/Xcode-26.6.app/Contents/Developer'
    // The runbook starts release.sh under Xcode 27; electron-builder runs under the icon's Xcode.
    expect(
      podSimBuildEnv({ PATH: '/bin', DEVELOPER_DIR: xcode26, POD_RELEASE_DEVELOPER_DIR: xcode27 })
    ).toEqual({ PATH: '/bin', DEVELOPER_DIR: xcode27 })
    // Started without one: xcode-select's Xcode, as for the rest of the release.
    expect(
      podSimBuildEnv({ PATH: '/bin', DEVELOPER_DIR: xcode26, POD_RELEASE_DEVELOPER_DIR: '' })
    ).toEqual({ PATH: '/bin' })
    // A packaging run outside release.sh keeps its DEVELOPER_DIR.
    expect(podSimBuildEnv({ PATH: '/bin', DEVELOPER_DIR: xcode27 })).toEqual({
      PATH: '/bin',
      DEVELOPER_DIR: xcode27
    })
    // release.sh hands electron-builder the DEVELOPER_DIR it was started with before replacing it.
    const release = readFileSync(join(__dirname, '../../../../../product/release.sh'), 'utf8')
    expect(release).toMatch(
      /POD_RELEASE_DEVELOPER_DIR="\$\{DEVELOPER_DIR:-\}" DEVELOPER_DIR="\$icon_developer_dir" \\\n[^\n]*\n\s*pnpm exec electron-builder /
    )
  })
})
