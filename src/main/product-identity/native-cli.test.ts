import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/native-cli/install-native-cli.cjs')
const installNativeCli: unknown = Reflect.get(Object(installer), 'installNativeCli')
const identity: unknown = require('../../../product/identity.json')

let root = ''
let binDir = ''

function run(
  command: string,
  args: string[],
  env: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      ORCA_USER_DATA_PATH: join(root, 'no-profile'),
      ...env
    }
  })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe.skipIf(process.platform !== 'darwin')('native podx', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-native-cli-'))
    const resources = join(root, 'Pod.app', 'Contents', 'Resources')
    binDir = join(resources, 'bin')
    mkdirSync(binDir, { recursive: true })
    // Stand-in for the patched bash launcher: reports how it was reached.
    writeFileSync(join(binDir, 'podx'), '#!/bin/sh\necho "node-launcher $*"\n')
    chmodSync(join(binDir, 'podx'), 0o755)
    writeFileSync(join(binDir, 'orca'), '#!/bin/sh\necho orca-script\n')
    const out = join(resources, 'app.asar.unpacked', 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'package.json'), '{"version":"9.9.9-test"}\n')
    if (typeof installNativeCli !== 'function') {
      throw new Error('install-native-cli.cjs exports no installNativeCli')
    }
    installNativeCli(resources, process.arch, identity)
  }, 600_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('installs the native binary as podx, links orca to it and keeps the launcher', () => {
    expect(readFileSync(join(binDir, 'podx')).subarray(0, 4).toString('hex')).toBe('cffaedfe')
    expect(lstatSync(join(binDir, 'orca')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(binDir, 'orca'))).toBe('podx')
    expect(readFileSync(join(binDir, 'podx-node'), 'utf8')).toContain('node-launcher')
  })

  it('answers --version from the bundled CLI package without Node', () => {
    expect(run(join(binDir, 'podx'), ['--version']).stdout).toBe('9.9.9-test')
    expect(run(join(binDir, 'orca'), ['-v']).stdout).toBe('9.9.9-test')
  })

  it('hands unported commands, help and missing runtimes to the launcher unchanged', () => {
    expect(run(join(binDir, 'podx'), ['terminal', 'send', '--text', 'a b']).stdout).toBe(
      'node-launcher terminal send --text a b'
    )
    expect(run(join(binDir, 'orca'), ['tab', 'list', '--help']).stdout).toBe(
      'node-launcher tab list --help'
    )
    expect(run(join(binDir, 'podx'), ['tab', 'list']).stdout).toBe('node-launcher tab list')
  })

  it('goes straight to the launcher with POD_NATIVE_CLI=0', () => {
    expect(run(join(binDir, 'podx'), ['--version'], { POD_NATIVE_CLI: '0' }).stdout).toBe(
      'node-launcher --version'
    )
  })
})
