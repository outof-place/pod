import { describe, expect, it, vi } from 'vitest'
import {
  checkWorkspaceVolume,
  defaultPnpmStoreDir,
  resolvePnpmStoreDir
} from './workspace-volume-checks'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

type Entry = { dev: number; ino: number }

/** A fake filesystem keyed by path; `caseInsensitive` folds lookups like APFS's default. */
function fakeStat(entries: Record<string, Entry>, caseInsensitive: boolean) {
  const table = new Map(
    Object.entries(entries).map(([path, entry]) => [
      caseInsensitive ? path.toLowerCase() : path,
      entry
    ])
  )
  return async (path: string): Promise<Entry | null> =>
    table.get(caseInsensitive ? path.toLowerCase() : path) ?? null
}

const statfs = async () => ({ bavail: 1_000, blocks: 4_000, bsize: 4096 })

describe('checkWorkspaceVolume', () => {
  const entries = {
    '/': { dev: 1, ino: 2 },
    '/Users': { dev: 1, ino: 3 },
    '/Users/me': { dev: 1, ino: 4 },
    '/Users/me/pod': { dev: 1, ino: 5 },
    '/Users/me/Library': { dev: 1, ino: 6 },
    '/Volumes': { dev: 1, ino: 7 },
    '/Volumes/Fast': { dev: 9, ino: 2 }
  }

  it('compares devices, probes case, and reads free space', async () => {
    const result = await checkWorkspaceVolume('/Users/me/pod', {
      home: '/Users/me',
      pnpmStoreDir: '/Users/me/Library/pnpm/store',
      stat: fakeStat(entries, true),
      statfs
    })
    expect(result).toEqual({
      pnpmStoreDir: '/Users/me/Library/pnpm/store',
      sameVolumeAsPnpmStore: true,
      caseSensitive: false,
      freeBytes: 1_000 * 4096,
      totalBytes: 4_000 * 4096
    })
  })

  it('flags a store on another volume and a case-sensitive root', async () => {
    const result = await checkWorkspaceVolume('/Users/me/pod/not-yet', {
      home: '/Users/me',
      pnpmStoreDir: '/Volumes/Fast/pnpm-store',
      stat: fakeStat(entries, false),
      statfs
    })
    expect(result.sameVolumeAsPnpmStore).toBe(false)
    expect(result.caseSensitive).toBe(true)
  })

  it('reports unknown when nothing on the path exists', async () => {
    const result = await checkWorkspaceVolume('/nowhere/pod', {
      home: '/Users/me',
      pnpmStoreDir: '/nowhere/store',
      stat: async () => null,
      statfs
    })
    expect(result).toMatchObject({
      sameVolumeAsPnpmStore: null,
      caseSensitive: null,
      freeBytes: null
    })
  })
})

describe('resolvePnpmStoreDir', () => {
  const runner = (stdout: string, code = 0): WorkspaceToolRunner =>
    vi.fn(async () => ({ code, stdout, stderr: '', timedOut: false }))

  it('uses pnpm config, else the macOS default', async () => {
    expect(await resolvePnpmStoreDir(runner('/Volumes/Fast/store\n'), '/Users/me', {})).toBe(
      '/Volumes/Fast/store'
    )
    expect(await resolvePnpmStoreDir(runner('~/stores/pnpm\n'), '/Users/me', {})).toBe(
      '/Users/me/stores/pnpm'
    )
    expect(await resolvePnpmStoreDir(runner('undefined\n'), '/Users/me', {})).toBe(
      defaultPnpmStoreDir('/Users/me')
    )
    expect(await resolvePnpmStoreDir(runner('', 127), '/Users/me', {})).toBe(
      '/Users/me/Library/pnpm/store'
    )
  })

  it('prefers an explicit store env without spawning pnpm', async () => {
    const run = runner('/elsewhere\n')
    expect(await resolvePnpmStoreDir(run, '/Users/me', { PNPM_STORE_DIR: '/env/store' })).toBe(
      '/env/store'
    )
    expect(run).not.toHaveBeenCalled()
  })
})
