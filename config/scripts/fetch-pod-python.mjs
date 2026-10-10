#!/usr/bin/env node
// Puts the Python that runs claude-acc into resources/python, which the Pod macOS build ships as
// Contents/Resources/python (config/pod-acc-extra-resources.cjs). Pinned in config/pod-python.json.
//
// Why embedded: a DMG user may have no Homebrew or uv Python, and /usr/bin/python3 opens the
// Command Line Tools installer when the CLT are missing.
//
//   node config/scripts/fetch-pod-python.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installPinnedAsset, readPin } from './pinned-release-asset.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
export const PYTHON_DIR = join(ROOT, 'resources', 'python')
const PIN = join(ROOT, 'config', 'pod-python.json')

// Never used by claude-acc (stdlib-only scripts run by bin/python3), and each one adds Mach-Os to
// sign or megabytes to ship. libpython3.14.dylib is for embedders: bin/python3.14 links Python in.
const TRIM = [
  'include',
  'share',
  'lib/pkgconfig',
  'lib/libpython3.14.dylib',
  'lib/python3.14/test',
  'lib/python3.14/idlelib',
  'lib/python3.14/tkinter',
  'lib/python3.14/turtledemo',
  'lib/python3.14/ensurepip',
  'lib/python3.14/pydoc_data',
  'bin/idle3',
  'bin/idle3.14',
  'bin/pip',
  'bin/pip3',
  'bin/pip3.14',
  'bin/pydoc3',
  'bin/pydoc3.14',
  'bin/python3-config',
  'bin/python3.14-config'
]
const TRIM_PREFIXES = ['libtcl', 'libtk', 'tcl', 'tk', 'itcl', 'thread']

/** The interpreter claude-acc's setup.sh links as $STATE/python. */
export function assertPython(dir) {
  for (const name of ['bin/python3', 'lib/python3.14/os.py']) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`embedded Python ${dir} has no ${name}`)
    }
  }
}

export function preparePython(dir) {
  for (const path of TRIM) {
    rmSync(join(dir, path), { recursive: true, force: true })
  }
  for (const name of readdirSync(join(dir, 'lib'))) {
    if (TRIM_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      rmSync(join(dir, 'lib', name), { recursive: true, force: true })
    }
  }
  // pip and its dist-info: claude-acc installs nothing into this interpreter
  const site = join(dir, 'lib/python3.14/site-packages')
  for (const name of existsSync(site) ? readdirSync(site) : []) {
    if (name !== 'README.txt') {
      rmSync(join(site, name), { recursive: true, force: true })
    }
  }
  const dynload = join(dir, 'lib/python3.14/lib-dynload')
  for (const name of existsSync(dynload) ? readdirSync(dynload) : []) {
    if (name.startsWith('_tkinter')) {
      rmSync(join(dynload, name), { force: true })
    }
  }
  // Why unchecked-hash: copies (cpSync, electron-builder) change source mtimes, and a timestamp
  // .pyc that looks stale makes Python write a new one into the signed bundle, breaking its seal.
  const compiled = spawnSync(
    join(dir, 'bin/python3'),
    [
      '-I',
      '-m',
      'compileall',
      '-q',
      '-j',
      '0',
      '--invalidation-mode',
      'unchecked-hash',
      'lib/python3.14'
    ],
    { cwd: dir, encoding: 'utf8' }
  )
  if (compiled.status !== 0) {
    throw new Error(`compileall in ${dir}: ${compiled.stderr || compiled.stdout}`)
  }
}

/** @param {{ into?: string, pin?: import('./pinned-release-asset.mjs').ReleasePin, download?: typeof fetch }} [options] */
export async function fetchPython({
  into = PYTHON_DIR,
  pin = readPin(PIN, 'embedded Python'),
  download = fetch
} = {}) {
  const source = await installPinnedAsset({
    pin,
    label: 'python-build-standalone asset',
    pinPath: 'config/pod-python.json',
    into,
    topDir: 'python',
    assert: assertPython,
    prepare: preparePython,
    download
  })
  return { asset: pin.asset, source }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  fetchPython()
    .then(({ asset, source }) => console.log(`embedded Python ${asset} from ${source}`))
    .catch((error) => {
      console.error(String(error.message ?? error))
      process.exit(1)
    })
}
