import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from './product-identity'
import { parseProductIdentity, type ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import {
  computerUseAppNotFound,
  productHelperCopy,
  productHelperName,
  productHelperNameTable,
  productHelperPath,
  productHelperPatterns,
  productProcessName
} from './product-helper-names'
import { resolveMacOSComputerUseExecutablePath } from '../computer/macos-native-provider-paths'

type HelperNamesModule = {
  productHelperNameTable: (identity: unknown) => Map<string, string>
  renameComputerUseExecutable: (resourcesDir: string, identity: unknown) => void
  renameSignedHelpers: (resourcesDir: string, identity: unknown) => void
  upstreamNameLeaks: (appPath: string) => string[]
}

const require = createRequire(import.meta.url)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: product/helper-names.cjs exports exactly these functions.
const helperNames = require('../../../product/helper-names.cjs') as HelperNamesModule
const productIdentityFile: unknown = require('../../../product/identity.json')

function pod(): ProductIdentity {
  return { ...podIdentityWithoutStablyServices(), computerUseDisplayName: 'Pod Computer Use' }
}

let root: string | null = null

function tempDir(): string {
  root = mkdtempSync(join(tmpdir(), 'pod-helper-names-'))
  return root
}

afterEach(() => {
  identity.current = null
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('helper names without a product identity', () => {
  it('keeps every upstream name, path, pattern and message', () => {
    const dir = tempDir()
    expect(productHelperName('orca-notification-status')).toBe('orca-notification-status')
    expect(productHelperPath(join(dir, 'Orca Computer Use.app'))).toBe(
      join(dir, 'Orca Computer Use.app')
    )
    expect(productHelperPatterns(['orca-computer-use-macos --permission'])).toEqual([
      'orca-computer-use-macos --permission'
    ])
    expect(productHelperCopy('Grant Accessibility to Orca Computer Use')).toBe(
      'Grant Accessibility to Orca Computer Use'
    )
    expect(computerUseAppNotFound()).toBe('Orca Computer Use.app was not found')
    expect(productProcessName('orca-tcc-login')).toBe('orca-tcc-login')
  })
})

describe('helper names in a product', () => {
  it('renames the Computer Use helper and the Contents/MacOS helpers', () => {
    expect(Object.fromEntries(productHelperNameTable(pod()))).toEqual({
      'Orca Computer Use.app': 'Pod Computer Use.app',
      'Orca Computer Use': 'Pod Computer Use',
      'orca-computer-use-macos': 'pod-computer-use-macos',
      'orca-notification-status': 'pod-notification-status',
      'orca-keyboard-layout': 'pod-keyboard-layout'
    })
  })

  it('leaves the Computer Use helper alone when the identity names none', () => {
    expect([...productHelperNameTable(podIdentityWithoutStablyServices()).keys()]).toEqual([
      'orca-notification-status',
      'orca-keyboard-layout'
    ])
  })

  it('builds the same table as packaging', () => {
    const shipped = parseProductIdentity(productIdentityFile)
    expect(helperNames.productHelperNameTable(productIdentityFile)).toEqual(
      productHelperNameTable(shipped)
    )
  })

  it('finds the renamed helper, and upstream’s name in dev builds', () => {
    identity.current = pod()
    const dir = tempDir()
    expect(productHelperPath(join(dir, 'orca-keyboard-layout'))).toBe(
      join(dir, 'orca-keyboard-layout')
    )
    writeFileSync(join(dir, 'pod-keyboard-layout'), '')
    expect(productHelperPath(join(dir, 'orca-keyboard-layout'))).toBe(
      join(dir, 'pod-keyboard-layout')
    )
  })

  it('resolves the packaged Computer Use executable under its product names', () => {
    identity.current = pod()
    const resources = tempDir()
    const macos = join(resources, 'Pod Computer Use.app', 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, 'pod-computer-use-macos'), '')
    vi.spyOn(process, 'cwd').mockReturnValue(resources)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      expect(resolveMacOSComputerUseExecutablePath()).toBe(join(macos, 'pod-computer-use-macos'))
    } finally {
      if (descriptor) {
        Object.defineProperty(process, 'resourcesPath', descriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      vi.restoreAllMocks()
    }
  })

  it('matches both names when closing setup helpers, and names the product helper in copy', () => {
    identity.current = pod()
    expect(productHelperPatterns(['orca-computer-use-macos[[:space:]]+--permission'])).toEqual([
      'orca-computer-use-macos[[:space:]]+--permission',
      'pod-computer-use-macos[[:space:]]+--permission'
    ])
    expect(productHelperCopy('Drag "Orca Computer Use" into the list')).toBe(
      'Drag "Pod Computer Use" into the list'
    )
    expect(computerUseAppNotFound()).toBe('Pod Computer Use.app was not found')
  })

  it('labels the terminal login trampoline after the product', () => {
    identity.current = pod()
    expect(productProcessName('orca-tcc-login')).toBe('pod-tcc-login')
  })
})

/** Contents/MacOS helper or helper-app executable: an ad-hoc signed copy of a system tool. */
function signedTool(path: string): void {
  copyFileSync('/usr/bin/true', path)
  execFileSync('codesign', ['--force', '--sign', '-', path], { stdio: 'ignore' })
}

function plist(path: string, values: Record<string, string>): void {
  const json = `${path}.json`
  writeFileSync(json, JSON.stringify(values))
  execFileSync('plutil', ['-convert', 'xml1', '-o', path, json])
  rmSync(json)
}

function readPlist(path: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' })
  )
}

describe.runIf(process.platform === 'darwin')('helper renames in a packaged bundle', () => {
  it('renames before and after upstream signs, keeps every signature valid, and passes the gate', () => {
    const app = join(tempDir(), 'Pod.app')
    const resources = join(app, 'Contents', 'Resources')
    const macos = join(app, 'Contents', 'MacOS')
    const helper = join(resources, 'Orca Computer Use.app')
    mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(macos, { recursive: true })
    plist(join(app, 'Contents', 'Info.plist'), { CFBundleName: 'Pod', CFBundleExecutable: 'Pod' })
    plist(join(helper, 'Contents', 'Info.plist'), {
      CFBundleIdentifier: 'codes.pod.app.computer-use',
      CFBundleDisplayName: 'Pod Computer Use',
      CFBundleExecutable: 'orca-computer-use-macos'
    })
    signedTool(join(helper, 'Contents', 'MacOS', 'orca-computer-use-macos'))
    for (const tool of ['Pod', 'orca-notification-status', 'orca-keyboard-layout']) {
      signedTool(join(macos, tool))
    }
    expect(helperNames.upstreamNameLeaks(app)).toEqual([
      'Pod.app: Contents/MacOS/orca-keyboard-layout',
      'Pod.app: Contents/MacOS/orca-notification-status',
      'Contents/Resources/Orca Computer Use.app: bundle name',
      'Contents/Resources/Orca Computer Use.app: Contents/MacOS/orca-computer-use-macos',
      'Contents/Resources/Orca Computer Use.app: Info.plist CFBundleExecutable "orca-computer-use-macos"'
    ])

    const shipped = {
      ...podIdentityWithoutStablyServices(),
      computerUseDisplayName: 'Pod Computer Use'
    }
    helperNames.renameComputerUseExecutable(resources, shipped)
    expect(readPlist(join(helper, 'Contents', 'Info.plist'))).toMatchObject({
      CFBundleExecutable: 'pod-computer-use-macos',
      ProductHostDisplayName: 'Pod',
      ProductHostCLIName: 'podx'
    })
    // What upstream's afterPack does under the upstream path.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', helper])
    helperNames.renameSignedHelpers(resources, shipped)

    const renamed = join(resources, 'Pod Computer Use.app')
    expect(existsSync(helper)).toBe(false)
    for (const path of [
      renamed,
      join(macos, 'pod-notification-status'),
      join(macos, 'pod-keyboard-layout')
    ]) {
      execFileSync('codesign', ['--verify', '--strict', path])
    }
    expect(helperNames.upstreamNameLeaks(app)).toEqual([])
  })

  it('covers a nested native app and its XPC services wherever the bundle embeds them', () => {
    const app = join(tempDir(), 'Pod.app')
    const native = join(app, 'Contents', 'Library', 'LoginItems', 'PodNative.app')
    const service = join(native, 'Contents', 'XPCServices', 'OrcaIntelligence.xpc')
    mkdirSync(join(service, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(native, 'Contents', 'MacOS'), { recursive: true })
    plist(join(app, 'Contents', 'Info.plist'), { CFBundleName: 'Pod' })
    plist(join(native, 'Contents', 'Info.plist'), {
      CFBundleName: 'Pod',
      CFBundleDisplayName: 'Orca (native)',
      CFBundleExecutable: 'PodNative'
    })
    plist(join(service, 'Contents', 'Info.plist'), {
      CFBundleName: 'PodIntelligence',
      CFBundleExecutable: 'PodIntelligenceService'
    })
    const nativeDir = 'Contents/Library/LoginItems/PodNative.app'
    expect(helperNames.upstreamNameLeaks(app)).toEqual([
      `${nativeDir}: Info.plist CFBundleDisplayName "Orca (native)"`,
      `${nativeDir}/Contents/XPCServices/OrcaIntelligence.xpc: bundle name`
    ])
  })
})
