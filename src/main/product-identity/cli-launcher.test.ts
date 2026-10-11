import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/cli-launchers/install-cli-launchers.cjs')
const installCliLaunchers: unknown = Reflect.get(Object(installer), 'installCliLaunchers')
const patchCliLauncher: unknown = Reflect.get(Object(installer), 'patchCliLauncher')
const UPSTREAM_LAUNCHER = join(__dirname, '../../../resources/darwin/bin/orca')

// Real path: the launcher resolves /var to /private/var.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pod-cli-launcher-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A bundle at `appPath` with the patched launchers and an executable that echoes how it ran. */
function bundle(appPath: string, executableName: string): string {
  const contents = join(appPath, 'Contents')
  const bin = join(contents, 'Resources', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  const executable = join(contents, 'MacOS', executableName)
  writeFileSync(executable, '#!/bin/sh\necho "ran $0 with $*"\n')
  chmodSync(executable, 0o755)
  writeFileSync(join(bin, 'orca'), readFileSync(UPSTREAM_LAUNCHER, 'utf8'))
  if (typeof installCliLaunchers !== 'function') {
    throw new Error('install-cli-launchers.cjs exports no installCliLaunchers')
  }
  installCliLaunchers(join(contents, 'Resources'), executableName, {
    cliName: 'podx',
    userDataName: 'Pod'
  })
  return bin
}

function run(launcher: string): string {
  const result = spawnSync('/bin/bash', [launcher, 'terminal', 'create'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root }
  })
  return `${result.stdout}${result.stderr}`.trim()
}

describe.skipIf(process.platform === 'win32')('Pod CLI launcher', () => {
  it('runs the executable of the bundle it sits in, also inside another .app', () => {
    const nested = join(root, 'Pod.app', 'Contents', 'Helpers', 'Pod Runtime.app')
    const bin = bundle(nested, 'Pod Runtime')
    // Upstream's first-.app rule named Pod.app/Contents/MacOS/Pod Runtime, which doesn't exist.
    expect(run(join(bin, 'podx'))).toBe(
      `ran ${nested}/Contents/MacOS/Pod Runtime with ${nested}/Contents/Resources/app.asar.unpacked/out/cli/index.js terminal create`
    )

    const plain = join(root, 'Plain.app')
    expect(run(join(bundle(plain, 'Pod'), 'orca'))).toContain(
      `ran ${plain}/Contents/MacOS/Pod with`
    )
  })

  it('follows a symlink on PATH to the bundle', () => {
    const app = join(root, 'Linked.app')
    const bin = bundle(app, 'Pod')
    const link = join(root, 'podx')
    symlinkSync(join(bin, 'podx'), link)
    expect(run(link)).toContain(`ran ${app}/Contents/MacOS/Pod with`)
  })

  it('says so when it is not inside a bundle', () => {
    const loose = join(root, 'loose')
    mkdirSync(loose, { recursive: true })
    if (typeof patchCliLauncher !== 'function') {
      throw new Error('install-cli-launchers.cjs exports no patchCliLauncher')
    }
    writeFileSync(
      join(loose, 'podx'),
      patchCliLauncher(readFileSync(UPSTREAM_LAUNCHER, 'utf8'), 'Pod', 'Pod')
    )
    expect(run(join(loose, 'podx'))).toContain('Unable to determine Orca.app path')
  })
})
