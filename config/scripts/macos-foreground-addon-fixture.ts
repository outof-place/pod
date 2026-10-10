import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setAppEnvironment } from '../../src/shared/app-environment'
import { getNativeProcessInfo } from '../../src/shared/native-process-info'
import { signalPosixPtyForegroundGroup } from '../../src/main/pty/posix-pty-foreground-group'

const [mode, pidText, tty, groupText, devRoot] = process.argv.slice(2)
const pid = Number(pidText)
const group = Number(groupText)
assert(mode && tty && devRoot && pid > 1 && group > 1, 'missing fixture identity')
const loadedPaths: string[] = []
const originalDlopen = process.dlopen
process.dlopen = (module, path, flags) => {
  loadedPaths.push(path)
  return originalDlopen(module, path, flags)
}

function installDevEnvironment(): void {
  setAppEnvironment({
    getAppPath: () => devRoot,
    isPackaged: () => false,
    getPath: () => '',
    getVersion: () => 'fixture',
    getAppMetrics: () => [],
    onWillQuit: () => {},
    exit: () => {}
  })
}

if (mode === 'dev') {
  assert.equal(getNativeProcessInfo(), null, 'plain Node loaded an addon from cwd')
  assert.deepEqual(loadedPaths, [])
  installDevEnvironment()
} else {
  assert('resourcesPath' in process && typeof process.resourcesPath === 'string')
  if (mode !== 'valid') {
    installDevEnvironment()
  }
}

const native = getNativeProcessInfo()
if (mode === 'valid' || mode === 'dev') {
  assert(native, 'trusted addon did not load')
  assert.deepEqual(native.readProcessForegroundGroup(pid, tty), { pid, tpgid: group, tty })
  assert.equal(native.readProcessForegroundGroup(pid, '/dev/null')?.tty, '??')
} else {
  assert.equal(native, null, 'missing, incompatible or disabled addon did not fall back')
}

const expectedAddon =
  mode === 'dev'
    ? join(devRoot, 'native', 'proc-info-darwin', '.build', 'release', 'orca-proc-info.node')
    : 'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? join(process.resourcesPath, 'native', 'orca-proc-info.node')
      : ''
assert(
  loadedPaths.every((path) => path === expectedAddon),
  'loader used an untrusted path'
)
if (mode === 'valid' || mode === 'dev' || mode === 'incompatible') {
  assert.deepEqual(loadedPaths, [expectedAddon])
}

let fellBackToRoot = false
signalPosixPtyForegroundGroup(pid, `/dev/${tty}`, 'SIGWINCH', () => {
  fellBackToRoot = true
})
assert.equal(fellBackToRoot, false, 'verified foreground group was not signaled')
console.log(
  JSON.stringify({ mode, arch: process.arch, electron: process.versions.electron, loadedPaths })
)
