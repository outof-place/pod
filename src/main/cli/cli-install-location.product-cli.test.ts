import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))

const { CliInstaller } = await import('./cli-installer')

function macCommandPath(options: ConstructorParameters<typeof CliInstaller>[0]): string {
  return String(Reflect.get(new CliInstaller(options), 'macCommandPath'))
}

describe('CliInstaller command name', () => {
  const packagedMac = {
    platform: 'darwin' as const,
    isPackaged: true,
    userDataPath: tmpdir(),
    homePath: tmpdir(),
    execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
    appPath: tmpdir()
  }

  it("installs a downstream product's own command, never Orca's `orca`", () => {
    expect(basename(macCommandPath({ ...packagedMac, productCliName: 'pod-cli' }))).toBe('pod-cli')
  })

  it('keeps `orca` for upstream builds', () => {
    expect(basename(macCommandPath({ ...packagedMac, productCliName: null }))).toBe('orca')
  })
})
