import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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
// Why from the launcher: POD_ once pod-decouple has run over the tree, ORCA_ before.
const TREE_PREFIX = readFileSync(UPSTREAM_LAUNCHER, 'utf8').includes('POD_NODE_OPTIONS')
  ? 'POD_'
  : 'ORCA_'

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
    userDataName: 'Pod',
    envPrefix: 'POD_'
  })
  return bin
}

function run(launcher: string, env: Record<string, string> = {}): string {
  const result = spawnSync('/bin/bash', [launcher, 'terminal', 'create'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root, ...env }
  })
  return `${result.stdout}${result.stderr}`.trim()
}

/** The launcher after pod-decouple, in a bundle whose executable prints the user data it got. */
function decoupledLauncher(appPath: string): string {
  const contents = join(appPath, 'Contents')
  const bin = join(contents, 'Resources', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  const executable = join(contents, 'MacOS', 'Pod')
  writeFileSync(executable, '#!/bin/sh\necho "user data $POD_USER_DATA_PATH"\n')
  chmodSync(executable, 0o755)
  if (typeof patchCliLauncher !== 'function') {
    throw new Error('install-cli-launchers.cjs exports no patchCliLauncher')
  }
  const decoupled = readFileSync(UPSTREAM_LAUNCHER, 'utf8').replaceAll('ORCA_', 'POD_')
  writeFileSync(join(bin, 'podx'), patchCliLauncher(decoupled, 'Pod', 'Pod', 'POD_'))
  return join(bin, 'podx')
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
    expect(run(join(bundle(plain, 'Pod'), 'podx'))).toContain(
      `ran ${plain}/Contents/MacOS/Pod with`
    )
  })

  it('ships the CLI under its product name, with the env prefix the tree uses', () => {
    const bin = bundle(join(root, 'Named.app'), 'Pod')
    expect(readFileSync(join(bin, 'orca'), 'utf8')).not.toContain('ELECTRON=')
    expect(readFileSync(join(bin, 'podx'), 'utf8')).toContain(
      `export ${TREE_PREFIX}USER_DATA_PATH=`
    )
  })

  it('keeps `orca` for one release as a shim that names the podx command and runs it', () => {
    const bin = bundle(join(root, 'Shim.app'), 'Pod')
    // A podx that only echoes, so the test sees what the shim hands on.
    writeFileSync(join(bin, 'podx'), '#!/bin/sh\necho "podx got $*"\n')
    const link = join(root, 'linked-orca')
    symlinkSync(join(bin, 'orca'), link)

    for (const path of [join(bin, 'orca'), link]) {
      const result = spawnSync('/bin/sh', [path, 'worktree', 'ps', '--json'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: root }
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('podx got worktree ps --json\n')
      expect(result.stderr).toBe('orca is now podx: podx worktree ps --json\n')
    }
  })

  // A terminal from before the decouple has only the legacy name; Orca.app's names Orca's data.
  it("takes a Pod terminal's ORCA_ user data and refuses another app's", () => {
    const launcher = decoupledLauncher(join(root, 'Decoupled.app'))
    const legacy = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
    const name = `${legacy.legacy}USER_DATA_PATH`
    const support = join(root, 'Library', 'Application Support')
    for (const folder of ['Pod/profile', 'Pod Dev', 'Pod2', 'orca']) {
      mkdirSync(join(support, folder), { recursive: true })
    }
    symlinkSync(join(support, 'orca'), join(support, 'Pod', 'to-orca'))
    // Spelled through /var while HOME is /private/var: both sides are compared resolved.
    for (const pods of [
      join(support, 'Pod'),
      join(support, 'Pod', 'profile').replace(/^\/private/, '')
    ]) {
      expect(run(launcher, { [name]: pods })).toBe(`user data ${pods}`)
    }
    // Orca.app's terminal, a dev Pod's, one whose name only starts with Pod's, and a symlink out
    // of Pod's folder into Orca's.
    for (const other of ['orca', 'Pod Dev', 'Pod2', 'Pod/to-orca'].map((folder) =>
      join(support, folder)
    )) {
      expect(run(launcher, { [name]: other })).toBe(
        `podx: no Pod runtime in env: ${name} is another app's data (${other})`
      )
    }
    const explicit = join(root, 'explicit')
    expect(
      run(launcher, {
        [name]: join(support, 'orca'),
        [`${legacy.current}USER_DATA_PATH`]: explicit
      })
    ).toBe(`user data ${explicit}`)
    expect(run(launcher)).toBe(`user data ${join(support, 'Pod')}`)
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
