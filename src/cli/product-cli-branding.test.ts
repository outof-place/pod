import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { printHelp } from './help'
import { _resetCliBrandingForTests } from './product-cli-branding'
import { COMMAND_SPECS } from './specs'

function capturedHelp(commandPath: string[]): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  printHelp(COMMAND_SPECS, commandPath)
  const text = log.mock.calls.map((call) => String(call[0])).join('\n')
  log.mockRestore()
  return text
}

// The packaged launcher runs the CLI with Electron's process: resourcesPath + versions.electron.
function launchFromResources(identity: object | null): void {
  const resourcesPath = mkdtempSync(join(tmpdir(), 'pod-cli-resources-'))
  if (identity) {
    writeFileSync(join(resourcesPath, 'product-identity.json'), JSON.stringify(identity))
  }
  vi.stubGlobal('process', {
    ...process,
    resourcesPath,
    versions: { ...process.versions, electron: '43.0.0' }
  })
  _resetCliBrandingForTests()
}

describe('CLI help in a product build', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetCliBrandingForTests()
  })

  it('names the upstream command when the app ships no identity', () => {
    launchFromResources(null)
    expect(capturedHelp([])).toContain('Usage: orca <command>')
  })

  it('names the product command and keeps repository identifiers', () => {
    launchFromResources({ formatVersion: 1, displayName: 'Pod', cliName: 'podx' })
    const root = capturedHelp([])
    expect(root).toContain('Usage: podx <command>')
    expect(root).not.toMatch(/(^|\s|`)orca\s/m)
    expect(capturedHelp(['project', 'setups'])).toContain(
      '$ podx project setups --project github:stablyai/orca'
    )
  })
})
