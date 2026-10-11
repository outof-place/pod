import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))

const { CliInstaller } = await import('./cli-installer')
const { parseProductIdentity } = await import('../product-identity/product-identity')

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

  it("installs Pod as `podx`, never CocoaPods' `pod`, in /usr/local/bin or ~/.local/bin", () => {
    const identity = parseProductIdentity(
      JSON.parse(readFileSync(join(__dirname, '../../../product/identity.json'), 'utf8'))
    )
    const productCliName = identity.cliName
    const paths = [
      macCommandPath({ ...packagedMac, productCliName }),
      macCommandPath({
        ...packagedMac,
        productCliName,
        defaultMacCommandPath: join(tmpdir(), 'no-such-bin-dir', productCliName)
      })
    ]
    expect(paths.map((path) => basename(path))).toEqual(['podx', 'podx'])
    expect(paths[1]).toBe(join(tmpdir(), '.local', 'bin', 'podx'))
  })

  it('keeps `orca` for upstream builds', () => {
    expect(basename(macCommandPath({ ...packagedMac, productCliName: null }))).toBe('orca')
  })
})
