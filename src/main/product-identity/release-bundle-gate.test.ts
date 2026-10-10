import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const gatePath = join(__dirname, '..', '..', '..', 'product', 'release-bundle-gate.cjs')
const gate: {
  MAX_DMG_BYTES: number
  PRODUCT_FILE_EXCLUSIONS: string[]
  PRODUCT_SIGN_IGNORE: string[]
  assertAppAsar(resourcesDir: string, listPackage?: (path: string) => string[]): void
  forbiddenAsarEntries(listing: string[]): string[]
} = require(gatePath)
const productConfig: {
  files: string[]
  mac: { signIgnore: string[] }
} = require('../../../product/electron-builder.pod.cjs')

let root: string | null = null

function scratch(): string {
  root = mkdtempSync(join(tmpdir(), 'pod-bundle-gate-'))
  return root
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('release bundle gate', () => {
  it('names parked outputs, reports and cache folders, not upstream dot files', () => {
    expect(
      gate.forbiddenAsarEntries([
        '/out/main/index.js',
        '/package.json',
        '/.oxlintrc.json',
        '/.ruff_cache/0.16.10/x',
        '/dist-0.0.1-test-2718f89dbd/mac-arm64/Pod.app/Contents/Info.plist',
        '/test-results/.last-run.json',
        '/cloud/README.md'
      ])
    ).toEqual(['.ruff_cache', 'dist-0.0.1-test-2718f89dbd', 'test-results'])
  })

  it('fails a polluted or oversized asar before signing and passes a clean one', () => {
    const resources = scratch()
    const asar = join(resources, 'app.asar')
    writeFileSync(asar, '')
    expect(() => gate.assertAppAsar(resources, () => ['/out/main/index.js'])).not.toThrow()
    expect(() =>
      gate.assertAppAsar(resources, () => ['/out/main/index.js', '/dist-old/Pod.app/x'])
    ).toThrow(/packs dist-old; move them out of the worktree/)
    truncateSync(asar, 401 * 1024 * 1024)
    expect(() => gate.assertAppAsar(resources, () => ['/out/main/index.js'])).toThrow(
      /app\.asar is 401 MB, over 400 MB/
    )
  })

  it('fails an oversized DMG from the command line', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'dist'))
    const dmg = join(dir, 'dist', 'Pod.dmg')
    writeFileSync(dmg, '')
    const run = (): number | null =>
      spawnSync(process.execPath, [gatePath, '--dmg', dmg], { encoding: 'utf8' }).status
    expect(run()).toBe(0)
    truncateSync(dmg, gate.MAX_DMG_BYTES + 1)
    expect(run()).toBe(1)
  })

  it('keeps the exclusions and sign skips in the product config', () => {
    expect(productConfig.files).toEqual(expect.arrayContaining(gate.PRODUCT_FILE_EXCLUSIONS))
    expect(productConfig.mac.signIgnore).toEqual(expect.arrayContaining(gate.PRODUCT_SIGN_IGNORE))
    const skip = new RegExp(gate.PRODUCT_SIGN_IGNORE[0])
    const unpacked = '/Pod.app/Contents/Resources/app.asar.unpacked/resources'
    expect(skip.test(`${unpacked}/brand/menu-barTemplate.svg`)).toBe(true)
    expect(skip.test(`${unpacked}/bin/rg`)).toBe(false)
  })
})
