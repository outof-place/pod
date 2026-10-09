import { describe, expect, it, vi } from 'vitest'
import { expandWorkspaceRoot, isPathInsideRoot, resolveWorkspaceRoot } from './workspace-root-path'
import {
  hasBlockingRootIssue,
  readDesktopDocumentsSync,
  validateWorkspaceRoot,
  type DesktopDocumentsSync
} from './workspace-root-validation'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

const home = '/Users/me'

function deps(sync: DesktopDocumentsSync, isDirectory: boolean | null = true) {
  return {
    home,
    readDesktopDocumentsSync: vi.fn(async () => sync),
    isDirectory: async () => isDirectory
  }
}

describe('workspace root paths', () => {
  it('expands ~ and rejects relative input', () => {
    expect(expandWorkspaceRoot('~/pod', home)).toBe('/Users/me/pod')
    expect(expandWorkspaceRoot('~', home)).toBe('/Users/me')
    expect(expandWorkspaceRoot('/Volumes/Work/pod/', home)).toBe('/Volumes/Work/pod')
    expect(expandWorkspaceRoot('pod', home)).toBeNull()
    expect(expandWorkspaceRoot('  ', home)).toBeNull()
  })

  it('defaults to ~/pod when the setting names no root', () => {
    expect(resolveWorkspaceRoot({}, home)).toBe('/Users/me/pod')
    expect(resolveWorkspaceRoot({ podWorkspaceRoot: 'relative' }, home)).toBe('/Users/me/pod')
    expect(resolveWorkspaceRoot({ podWorkspaceRoot: '~/code' }, home)).toBe('/Users/me/code')
  })

  it('treats only the root and its descendants as inside', () => {
    expect(isPathInsideRoot('/Users/me/pod', '/Users/me/pod')).toBe(true)
    expect(isPathInsideRoot('/Users/me/pod/acme/widget', '/Users/me/pod')).toBe(true)
    expect(isPathInsideRoot('/Users/me/pod/..foo', '/Users/me/pod')).toBe(true)
    expect(isPathInsideRoot('/Users/me/pods/widget', '/Users/me/pod')).toBe(false)
    expect(isPathInsideRoot('/Users/me', '/Users/me/pod')).toBe(false)
  })
})

describe('validateWorkspaceRoot', () => {
  it('accepts the default root without reading Finder preferences', async () => {
    const validation = deps('on')
    const result = await validateWorkspaceRoot('~/pod', validation)
    expect(result).toEqual({ root: '/Users/me/pod', issues: [] })
    expect(validation.readDesktopDocumentsSync).not.toHaveBeenCalled()
  })

  it('refuses iCloud Drive', async () => {
    const result = await validateWorkspaceRoot(
      '~/Library/Mobile Documents/com~apple~CloudDocs/pod',
      deps('off')
    )
    expect(result.issues).toEqual([{ code: 'icloud-drive', severity: 'error' }])
    expect(hasBlockingRootIssue(result)).toBe(true)
  })

  it('refuses Documents when iCloud syncs it, and always warns about TCC', async () => {
    const synced = await validateWorkspaceRoot('~/Documents/pod', deps('on'))
    expect(synced.issues).toEqual([
      { code: 'icloud-desktop-documents', severity: 'error' },
      { code: 'documents-desktop-tcc', severity: 'warning' }
    ])
    const local = await validateWorkspaceRoot('~/Desktop/pod', deps('off'))
    expect(local.issues).toEqual([{ code: 'documents-desktop-tcc', severity: 'warning' }])
    expect(hasBlockingRootIssue(local)).toBe(false)
  })

  it('warns instead of refusing when the sync state is unknown', async () => {
    const result = await validateWorkspaceRoot('~/Documents/pod', deps('unknown'))
    expect(result.issues.map((issue) => issue.severity)).toEqual(['warning', 'warning'])
  })

  it('reports blank, relative and file roots', async () => {
    expect((await validateWorkspaceRoot('', deps('off'))).issues[0].code).toBe('empty')
    expect((await validateWorkspaceRoot('pod', deps('off'))).issues[0].code).toBe('not-absolute')
    expect((await validateWorkspaceRoot('~/pod', deps('off', false))).issues[0].code).toBe(
      'not-a-directory'
    )
  })
})

describe('readDesktopDocumentsSync', () => {
  const runner = (values: Record<string, string | null>): WorkspaceToolRunner =>
    vi.fn(async (_tool, args) => {
      const value = values[args[2]]
      return value === null || value === undefined
        ? { code: 1, stdout: '', stderr: 'does not exist', timedOut: false }
        : { code: 0, stdout: `${value}\n`, stderr: '', timedOut: false }
    })

  it('reads both Finder keys', async () => {
    expect(
      await readDesktopDocumentsSync(
        runner({ FXICloudDriveDesktop: '1', FXICloudDriveDocuments: '0' })
      )
    ).toBe('on')
    expect(
      await readDesktopDocumentsSync(
        runner({ FXICloudDriveDesktop: '0', FXICloudDriveDocuments: '0' })
      )
    ).toBe('off')
    expect(await readDesktopDocumentsSync(runner({ FXICloudDriveDesktop: '0' }))).toBe('unknown')
  })
})
