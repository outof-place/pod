import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { setWorkspaceRoot } from './workspace-root-setting'

describe('podWorkspace.setRoot', () => {
  const setup = () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pod-ws-root-')))
    let settings: GlobalSettings = { ...getDefaultSettings(home), podWorkspaceRoot: '' }
    const notified: boolean[] = []
    const deps = {
      home,
      validation: { home, readDesktopDocumentsSync: async () => 'off' as const },
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>, options: { notifyListeners: boolean }) => {
        settings = { ...settings, ...updates }
        notified.push(options.notifyListeners)
      }
    }
    return { home, deps, settings: () => settings, notified }
  }

  it('saves a folder that passes the checks, one not made yet, and blank as the default', async () => {
    const { home, deps, settings, notified } = setup()
    mkdirSync(join(home, 'code'))
    expect((await setWorkspaceRoot(join(home, 'later'), deps)).resolvedRoot).toBe(
      join(home, 'later')
    )
    expect(await setWorkspaceRoot('~/code ', deps)).toEqual({
      root: '~/code',
      resolvedRoot: join(home, 'code')
    })
    expect(settings().podWorkspaceRoot).toBe('~/code')
    expect(await setWorkspaceRoot(null, deps)).toEqual({
      root: '',
      resolvedRoot: join(home, 'pod')
    })
    expect(settings().podWorkspaceRoot).toBe('')
    // Listeners on: the root sync and the windows hear of each write, as from settings:set.
    expect(notified).toEqual([true, true, true])
  })

  it('refuses what validateRoot calls an error, and saves nothing', async () => {
    const { home, deps, settings } = setup()
    await expect(setWorkspaceRoot('relative/path', deps)).rejects.toThrow(/not-absolute/)
    writeFileSync(join(home, 'notes'), '')
    await expect(setWorkspaceRoot(join(home, 'notes'), deps)).rejects.toThrow(/not-a-directory/)
    const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'pod')
    mkdirSync(icloud, { recursive: true })
    await expect(setWorkspaceRoot(icloud, deps)).rejects.toThrow(/icloud-drive/)
    expect(settings().podWorkspaceRoot).toBe('')
  })
})
