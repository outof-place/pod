import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const gate: {
  appLayout(app: string, appId: string): 'classic' | 'one-app' | null
  feedProblems(layout: 'classic' | 'one-app' | null, assets: string[]): string[]
} = require('../../../product/release-feed-gate.cjs')

const APP_ID = 'codes.pod.app'
let root: string | null = null

function bundle(path: string, bundleId: string): string {
  mkdirSync(join(path, 'Contents'), { recursive: true })
  writeFileSync(
    join(path, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
      `<key>CFBundleIdentifier</key>\n<string>${bundleId}</string>\n</dict></plist>\n`
  )
  return path
}

function scratch(): string {
  root = mkdtempSync(join(tmpdir(), 'pod-feed-gate-'))
  return root
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('release feed gate', () => {
  it('tells a classic app from one-app by where the product app sits', () => {
    const dir = scratch()
    const classic = bundle(join(dir, 'classic', 'Pod.app'), APP_ID)
    const oneApp = bundle(join(dir, 'one-app', 'Pod.app'), 'codes.pod.native')
    bundle(join(oneApp, 'Contents', 'Helpers', 'Pod Runtime.app'), APP_ID)
    const other = bundle(join(dir, 'other', 'Pod.app'), 'codes.pod.native')

    expect(gate.appLayout(classic, APP_ID)).toBe('classic')
    expect(gate.appLayout(oneApp, APP_ID)).toBe('one-app')
    expect(gate.appLayout(other, APP_ID)).toBeNull()
  })

  it('keeps latest-mac.yml off a one-app release, so classic installs never download it', () => {
    expect(
      gate.feedProblems('one-app', ['dist/Pod.dmg', 'dist/latest-mac.yml', 'dist/appcast.xml'])
    ).toEqual([
      'a one-app release must not publish latest-mac.yml: classic installs would download it'
    ])
    expect(
      gate.feedProblems('one-app', ['dist/Pod.dmg', 'dist/beta-mac.yml', 'dist/appcast.xml'])
    ).toHaveLength(1)
    expect(gate.feedProblems('one-app', ['dist/Pod.dmg'])).toEqual([
      'a one-app release needs appcast.xml (product/scripts/sparkle-appcast.sh)'
    ])
    expect(
      gate.feedProblems('one-app', ['dist/Pod.dmg', 'dist/Pod.zip', 'dist/appcast.xml'])
    ).toEqual([])
  })

  it('keeps appcast.xml off a classic release, so Sparkle never installs it over one-app', () => {
    expect(
      gate.feedProblems('classic', ['dist/Pod.dmg', 'dist/latest-mac.yml', 'dist/appcast.xml'])
    ).toEqual([
      'a classic release must not publish appcast.xml: Sparkle would install it over one-app installs'
    ])
    expect(
      gate.feedProblems('classic', ['dist/Pod.dmg', 'dist/Pod.zip', 'dist/latest-mac.yml'])
    ).toEqual([])
  })

  it('refuses an app that is neither', () => {
    expect(gate.feedProblems(null, ['dist/latest-mac.yml'])).toHaveLength(1)
  })
})
