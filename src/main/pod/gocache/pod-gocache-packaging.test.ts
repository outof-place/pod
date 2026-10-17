// The packaging side of pod-gocache (native/pod-gocache-macos/scripts/build.sh,
// product/gocache/install-pod-gocache.cjs): what a release build puts in the app, and what stops it.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { podGoCacheBundledHelperPath } from './pod-gocache-paths'

const REPO = join(__dirname, '../../../..')
const BUILD = join(REPO, 'native/pod-gocache-macos/scripts/build.sh')
const require = createRequire(import.meta.url)
type SignOptions = {
  entitlements?: string
  hardenedRuntime?: boolean
  additionalArguments?: string[]
}
const installer: unknown = require('../../../../product/gocache/install-pod-gocache.cjs')
const field = (name: string): unknown => Reflect.get(Object(installer), name)
const policy: {
  signWithProductEntitlements: unknown
} = require('../../../../product/entitlements-policy.cjs')

function callable<T>(name: string): T {
  const value = field(name)
  if (typeof value !== 'function') {
    throw new Error(`install-pod-gocache.cjs exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked to be a function just above; the test states the signature it relies on.
  return value as T
}

let root = ''
let module = ''

// A module with the frozen CLI's shape: main.version is what build.sh stamps.
function writeFixtureModule(dir: string): void {
  mkdirSync(join(dir, 'cmd/pod-gocache'), { recursive: true })
  writeFileSync(join(dir, 'go.mod'), 'module example.com/podgocachefixture\n\ngo 1.27\n')
  writeFileSync(
    join(dir, 'cmd/pod-gocache/main.go'),
    [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'var version = "dev"',
      '',
      'func main() {',
      '\tif len(os.Args) > 1 && os.Args[1] == "version" {',
      '\t\tfmt.Println("pod-gocache " + version)',
      '\t\treturn',
      '\t}',
      '\tos.Exit(64)',
      '}',
      ''
    ].join('\n')
  )
}

function build(args: string[], env: Record<string, string | undefined> = process.env) {
  return spawnSync('bash', [BUILD, '--module', module, ...args], { encoding: 'utf8', env })
}

/** The CPU type of a thin Mach-O, or every slice of a universal one, as `lipo -archs` names them. */
function archs(path: string): string {
  return spawnSync('lipo', ['-archs', path], { encoding: 'utf8' }).stdout.trim()
}

describe.skipIf(process.platform !== 'darwin')('pod-gocache build', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-gocache-pack-'))
    module = join(root, 'module')
    writeFixtureModule(module)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['arm64', 'arm64'],
    ['amd64', 'x86_64'],
    ['universal', 'x86_64 arm64']
  ])(
    'builds %s with the version stamped in, and proves it answers',
    (arch, expected) => {
      const out = join(root, `pod-gocache-${arch}`)

      const run = build(['--arch', arch, '--out', out, '--version', '0.4.2'])

      expect(run.status, run.stderr).toBe(0)
      expect(archs(out)).toBe(expected)
      if (arch !== 'amd64') {
        expect(spawnSync(out, ['version'], { encoding: 'utf8' }).stdout).toBe('pod-gocache 0.4.2\n')
      }
    },
    180_000
  )

  it('fails loudly, naming Go, on a machine without it', () => {
    const run = build(['--arch', 'arm64', '--out', join(root, 'nogo')], {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME
    })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/Go is missing/)
  })

  it("ignores the builder's `go env -w` settings", () => {
    const goenv = join(root, 'go.env')
    // a value that fails any build that reads it
    writeFileSync(goenv, 'GOEXPERIMENT=nosuchexperiment\n')

    const run = build(['--arch', 'arm64', '--out', join(root, 'goenv'), '--version', '0.4.2'], {
      ...process.env,
      GOENV: goenv
    })

    expect(run.status, run.stderr).toBe(0)
  }, 180_000)

  it('--check-toolchain answers the pinned Go, and names Go when it is missing', () => {
    const ok = spawnSync('bash', [BUILD, '--check-toolchain'], { encoding: 'utf8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/^go version go1\.27\.2 /)

    const none = spawnSync('bash', [BUILD, '--check-toolchain'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }
    })
    expect(none.status).not.toBe(0)
    expect(none.stderr).toMatch(/Go is missing/)
  })

  it('fails loudly when the version did not reach the binary', () => {
    const renamed = join(root, 'renamed')
    writeFixtureModule(renamed)
    const main = join(renamed, 'cmd/pod-gocache/main.go')
    writeFileSync(
      main,
      spawnSync('sed', ['s/var version/var buildVersion/; s/+ version/+ buildVersion/', main], {
        encoding: 'utf8'
      }).stdout
    )

    const run = spawnSync(
      'bash',
      [
        BUILD,
        '--module',
        renamed,
        '--arch',
        'arm64',
        '--out',
        join(root, 'unstamped'),
        '--version',
        '0.4.2'
      ],
      { encoding: 'utf8' }
    )

    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/0\.4\.2/)
  }, 180_000)
})

describe.skipIf(process.platform !== 'darwin')('pod-gocache in the packaged app', () => {
  let appRoot = ''
  let app = ''

  beforeAll(() => {
    appRoot = mkdtempSync(join(tmpdir(), 'pod-gocache-app-'))
    app = join(appRoot, 'Pod.app')
    module = join(appRoot, 'module')
    writeFixtureModule(module)
  })

  afterAll(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it.each([
    ['arm64', 'arm64'],
    ['x64', 'x86_64']
  ])(
    "afterPack's step puts a %s helper in Contents/Resources/bin",
    (arch, expected) => {
      const install =
        callable<(app: string, repo: string, arch: string, o: object) => void>(
          'installPodGoCacheHelper'
        )
      install(app, REPO, arch, { module })

      expect(archs(join(app, 'Contents/Resources/bin/pod-gocache'))).toBe(expected)
    },
    180_000
  )

  it('refuses an arch it has no build for', () => {
    const install =
      callable<(app: string, repo: string, arch: string) => void>('installPodGoCacheHelper')

    expect(() => install(app, REPO, 'armv7l')).toThrow(/armv7l/)
  })

  it('electron-builder signs it as codes.pod.gocache with no entitlements, beside pod-sim', async () => {
    const macCodeSign: { sign: unknown } = createRequire(
      join(REPO, 'product/entitlements-policy.cjs')
    )('app-builder-lib/out/codeSign/macCodeSign')
    const realSign = macCodeSign.sign
    let handed: unknown = null
    macCodeSign.sign = async (options: { optionsForFile: unknown }) => {
      handed = options.optionsForFile
    }
    try {
      const sign = policy.signWithProductEntitlements
      if (typeof sign !== 'function') {
        throw new Error('entitlements-policy.cjs exports no signWithProductEntitlements')
      }
      await sign(
        {
          app: '/out/Pod.app',
          optionsForFile: () => ({ entitlements: '/e.plist', hardenedRuntime: true })
        },
        { appInfo: { productFilename: 'Pod' } }
      )
    } finally {
      macCodeSign.sign = realSign
    }
    const optionsForFile: unknown = handed
    if (typeof optionsForFile !== 'function') {
      throw new Error('mac.sign handed osx-sign no optionsForFile')
    }
    const forFile = (path: string): SignOptions => Reflect.apply(optionsForFile, undefined, [path])
    const gocache = forFile('/out/Pod.app/Contents/Resources/bin/pod-gocache')
    expect(gocache.additionalArguments).toEqual(['--identifier', 'codes.pod.gocache'])
    expect(basename(gocache.entitlements ?? '')).toBe('none.plist')
    expect(forFile('/out/Pod.app/Contents/Resources/bin/pod-sim').additionalArguments).toEqual([
      '--identifier',
      'codes.pod.sim'
    ])
    expect(forFile('/out/Pod.app/Contents/MacOS/Pod').additionalArguments).toBeUndefined()
  })

  it("afterSign's check refuses a missing, unsigned or misnamed helper and passes a proper one", () => {
    const assertSigned = callable<(app: string) => void>('assertPodGoCacheSigned')
    const helper = join(app, 'Contents/Resources/bin/pod-gocache')
    const sign = (...args: string[]) =>
      spawnSync('codesign', ['--force', '--sign', '-', ...args, helper], { encoding: 'utf8' })
    rmSync(helper, { force: true })
    expect(() => assertSigned(app)).toThrow(/missing/)

    copyFileSync('/usr/bin/true', helper)
    spawnSync('codesign', ['--remove-signature', helper])
    expect(() => assertSigned(app)).toThrow()

    sign('--options', 'runtime')
    expect(() => assertSigned(app)).toThrow(/identifier is not codes\.pod\.gocache/)

    sign('--identifier', 'codes.pod.gocache')
    expect(() => assertSigned(app)).toThrow(/hardened runtime/)

    sign('--identifier', 'codes.pod.gocache', '--options', 'runtime')
    expect(() => assertSigned(app)).not.toThrow()
  })

  it('is placed where a packaged runtime looks for it', () => {
    const helper = Object(field('POD_GOCACHE'))
    expect(helper.identifier).toBe('codes.pod.gocache')
    expect(
      podGoCacheBundledHelperPath(join('/Applications/Pod.app', 'Contents', 'Resources'))
    ).toBe(join('/Applications/Pod.app', helper.path))
  })
})
