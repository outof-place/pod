import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createForegroundFixtureBundle } from './macos-foreground-fixture-bundle.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))

describe('isolated foreground fixture bundle', () => {
  let root
  let sourceApp
  let sourceAddon
  let sourceFile
  let scratch
  let app

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      signal: null,
      stdout: '',
      stderr: 'signature'
    })
    root = mkdtempSync(join(tmpdir(), 'orca-foreground-bundle-test-'))
    sourceApp = join(root, 'Electron.app')
    sourceAddon = join(root, 'addon.node')
    sourceFile = join(sourceApp, 'Contents', 'Electron')
    scratch = join(root, 'scratch')
    app = join(scratch, 'Fixture.app')
    mkdirSync(join(sourceApp, 'Contents'), { recursive: true })
    mkdirSync(scratch)
    writeFileSync(sourceFile, 'original executable')
    writeFileSync(sourceAddon, 'original addon')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function create() {
    return createForegroundFixtureBundle({ sourceApp, sourceAddon, app, scratch })
  }

  it('copies before validation and preserves both sources through signing and cleanup', () => {
    const bundle = create()
    expect(bundle.validatedEntries).toBe(2)
    bundle.seal()
    expect(execFileSync).toHaveBeenCalledWith(
      'codesign',
      ['--force', '--deep', '--sign', '-', app],
      expect.objectContaining({ env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1' }) })
    )
    bundle.assertSourcesPreserved()
    bundle.cleanup()
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
    expect(readFileSync(sourceAddon, 'utf8')).toBe('original addon')
  })

  it('rejects an escaping symlink before signing', () => {
    const bundle = create()
    symlinkSync(sourceFile, join(app, 'outside'))
    expect(() => bundle.seal()).toThrow('bundle entry escapes its app')
    expect(execFileSync).not.toHaveBeenCalled()
    bundle.cleanup()
  })

  it('validates copied links before returning a bundle for setup', () => {
    symlinkSync(sourceFile, join(sourceApp, 'Contents', 'absolute-link'))
    expect(create).toThrow('bundle entry escapes its app')
    expect(execFileSync).not.toHaveBeenCalled()
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
  })

  it('rejects a source-linked regular file before signing', () => {
    const bundle = create()
    const fixtureFile = join(app, 'Contents', 'Electron')
    rmSync(fixtureFile)
    linkSync(sourceFile, fixtureFile)
    expect(() => bundle.seal()).toThrow('fixture file is hard-linked')
    expect(execFileSync).not.toHaveBeenCalled()
    expect(() => bundle.cleanup()).toThrow('fixture altered original Electron or addon files')
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
  })

  it('detects source mutation and still removes only its owned scratch', () => {
    const bundle = create()
    writeFileSync(sourceFile, 'changed original')
    expect(() => bundle.assertSourcesPreserved()).toThrow(
      'fixture altered original Electron or addon files'
    )
    expect(() => bundle.cleanup()).toThrow('fixture altered original Electron or addon files')
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(sourceFile, 'utf8')).toBe('changed original')
  })

  it('detects a changed source signature without relying only on file content', () => {
    const bundle = create()
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      signal: null,
      stdout: '',
      stderr: 'changed signature'
    })
    expect(() => bundle.assertSourcesPreserved()).toThrow(
      'fixture altered original Electron or addon files'
    )
    bundle.cleanup()
  })

  it('rejects a replaced fixture root before signing', () => {
    const bundle = create()
    rmSync(app, { recursive: true })
    symlinkSync(sourceApp, app, 'dir')
    expect(() => bundle.seal()).toThrow('fixture app must be a direct directory')
    expect(execFileSync).not.toHaveBeenCalled()
    bundle.cleanup()
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
  })

  it('refuses cleanup after its scratch is replaced by a source link', () => {
    const bundle = create()
    rmSync(scratch, { recursive: true })
    symlinkSync(sourceApp, scratch, 'dir')
    expect(() => bundle.cleanup()).toThrow('scratch directory identity changed')
    expect(existsSync(sourceFile)).toBe(true)
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
  })

  it('canonicalizes a source app link before copying its directory', () => {
    const linkedSource = join(root, 'linked-app')
    symlinkSync(sourceApp, linkedSource, 'dir')
    const bundle = createForegroundFixtureBundle({
      sourceApp: linkedSource,
      sourceAddon,
      app,
      scratch
    })
    bundle.validate()
    bundle.cleanup()
    expect(readFileSync(sourceFile, 'utf8')).toBe('original executable')
  })
})
