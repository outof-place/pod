import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'

export const BUNDLE_NAME = 'Pod Runtime.app'
export const ENTRY_REL = join(
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'out',
  'main',
  'daemon-entry.js'
)

export const hostApp = {
  isPackaged: true,
  userDataPath: '',
  appPath: '',
  version: '9.9.9'
}

export function installHostApp(): void {
  const environment: AppEnvironment = {
    getPath: () => hostApp.userDataPath,
    getAppPath: () => hostApp.appPath,
    getVersion: () => hostApp.version,
    isPackaged: () => hostApp.isPackaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  }
  setAppEnvironment(environment)
}

/** A signed-looking runtime bundle: main executable, Info.plist, seal, asar and the daemon entry. */
export function buildBundleFixture(
  installDir: string,
  bundleName = BUNDLE_NAME
): { bundleDir: string; execPath: string } {
  const bundleDir = join(installDir, bundleName)
  const files: Record<string, string> = {
    [join('Contents', 'MacOS', 'Pod')]: 'mach-o',
    [join('Contents', 'Info.plist')]: '<plist>codes.pod.app</plist>',
    [join('Contents', '_CodeSignature', 'CodeResources')]: '<plist>seal</plist>',
    [join('Contents', 'Resources', 'app.asar')]: 'asar',
    [ENTRY_REL]: 'module.exports = {}',
    [join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')]: 'dylib'
  }
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(join(bundleDir, rel, '..'), { recursive: true })
    writeFileSync(join(bundleDir, rel), contents)
  }
  return { bundleDir, execPath: join(bundleDir, 'Contents', 'MacOS', 'Pod') }
}

function makeWritable(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    return
  }
  chmodSync(path, stat.mode | 0o200)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      makeWritable(join(path, name))
    }
  }
}

export type ToolState = {
  calls: { program: string; args: readonly string[] }[]
  codesignCode: number
  lsofStdout: string
}

const ok: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}

/** Stand-ins for cp, codesign, chmod and lsof, so the suite runs on every CI host. */
export function fakeTool(state: ToolState, spec: ProcessSpec): ProcessResult {
  const args = spec.args ?? []
  state.calls.push({ program: spec.program, args })
  switch (spec.program) {
    case '/bin/cp':
      cpSync(args[2], args[3], { recursive: true, verbatimSymlinks: true })
      return ok
    case '/usr/bin/codesign':
      return state.codesignCode === 0
        ? ok
        : {
            ...ok,
            code: state.codesignCode,
            stderr: `${args[3]}: a sealed resource is missing or invalid\n`
          }
    case '/bin/chmod':
      makeWritable(args[2])
      return ok
    case '/usr/sbin/lsof':
      return state.lsofStdout ? { ...ok, stdout: state.lsofStdout } : { ...ok, code: 1 }
    default:
      throw new Error(`unexpected tool ${spec.program}`)
  }
}
