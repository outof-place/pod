import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir: fsMocks.readdir,
  wslGatedStat: fsMocks.stat
}))

import {
  SESSION_TREE_SAFETY_WALK_INTERVAL_MS,
  SESSION_TREE_WATCH_RETRY_INTERVAL_MS,
  applySessionTreeChanges,
  applySessionTreeWatchState,
  forgetSessionTreePaths,
  installSessionTreeWatchRequests,
  resetSessionTreeCacheForTests,
  sessionTreeReader
} from './session-tree-cache'

const ROOT = join('/', 'home', 'u', '.claude', 'projects')
const PROJECT = join(ROOT, 'proj')
const TRANSCRIPT = join(PROJECT, 'a.jsonl')

function dirent(name: string, directory: boolean): Dirent {
  return {
    name,
    parentPath: '',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => directory,
    isFIFO: () => false,
    isFile: () => !directory,
    isSocket: () => false,
    isSymbolicLink: () => false
  }
}

function fileStats(mtimeMs: number): Pick<Stats, 'mtimeMs' | 'size' | 'dev' | 'ino' | 'nlink'> {
  return { mtimeMs, size: 10, dev: 1, ino: 2, nlink: 1 }
}

function readerFor(root: string) {
  const reader = sessionTreeReader(root)
  if (!reader) {
    throw new Error('expected a reader')
  }
  return reader
}

let requests: string[]

beforeEach(() => {
  resetSessionTreeCacheForTests()
  requests = []
  fsMocks.readdir.mockReset()
  fsMocks.stat.mockReset()
  fsMocks.readdir.mockImplementation(async (dir: string) =>
    dir === ROOT ? [dirent('proj', true)] : [dirent('a.jsonl', false)]
  )
  fsMocks.stat.mockImplementation(async () => fileStats(1))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sessionTreeReader', () => {
  it('leaves discovery on the gated primitives when no host can watch', () => {
    expect(sessionTreeReader(ROOT)).toBeNull()
  })

  it('asks to watch a root once it lists, and not again within the retry interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    installSessionTreeWatchRequests((root) => requests.push(root))
    fsMocks.readdir.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    await expect(readerFor(ROOT).readDirectory(ROOT)).rejects.toThrow('missing')
    expect(requests).toEqual([])
    await readerFor(ROOT).readDirectory(ROOT)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(requests).toEqual([ROOT])

    vi.advanceTimersByTime(SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(requests).toEqual([ROOT, ROOT])
  })

  it('serves a live root from memory and rereads only what a change names', async () => {
    installSessionTreeWatchRequests((root) => requests.push(root))
    applySessionTreeWatchState(ROOT, 'live')
    const reader = readerFor(ROOT)

    for (let pass = 0; pass < 3; pass++) {
      await reader.readDirectory(ROOT)
      await reader.readDirectory(PROJECT)
      await reader.stat(TRANSCRIPT)
    }
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)
    expect(fsMocks.stat).toHaveBeenCalledTimes(1)

    fsMocks.stat.mockImplementation(async () => fileStats(2))
    applySessionTreeChanges(ROOT, [{ type: 'update', path: TRANSCRIPT }])
    await reader.readDirectory(ROOT)
    await reader.readDirectory(PROJECT)
    expect((await reader.stat(TRANSCRIPT)).mtimeMs).toBe(2)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)
    expect(fsMocks.stat).toHaveBeenCalledTimes(2)
  })

  it('drops the parent listing and the whole subtree on a create or delete', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(ROOT, 'live')
    const reader = readerFor(ROOT)
    await reader.readDirectory(ROOT)
    await reader.readDirectory(PROJECT)
    await reader.stat(TRANSCRIPT)

    applySessionTreeChanges(ROOT, [{ type: 'delete', path: PROJECT }])
    await reader.readDirectory(ROOT)
    await reader.readDirectory(PROJECT)
    await reader.stat(TRANSCRIPT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(4)
    expect(fsMocks.stat).toHaveBeenCalledTimes(2)

    forgetSessionTreePaths([TRANSCRIPT])
    await reader.readDirectory(ROOT)
    await reader.readDirectory(PROJECT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(5)
  })

  it('does not keep a read that a change raced', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(ROOT, 'live')
    const reader = readerFor(ROOT)
    let release!: (entries: Dirent[]) => void
    fsMocks.readdir.mockImplementationOnce(
      () =>
        new Promise<Dirent[]>((resolve) => {
          release = resolve
        })
    )

    const stale = reader.readDirectory(PROJECT)
    applySessionTreeChanges(ROOT, [{ type: 'create', path: join(PROJECT, 'b.jsonl') }])
    release([dirent('a.jsonl', false)])
    await stale
    fsMocks.readdir.mockResolvedValueOnce([dirent('a.jsonl', false), dirent('b.jsonl', false)])

    expect((await reader.readDirectory(PROJECT)).map((entry) => entry.name)).toEqual([
      'a.jsonl',
      'b.jsonl'
    ])
  })

  it('starts cold after a reset, a lost watch, or the safety interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    installSessionTreeWatchRequests((root) => requests.push(root))
    applySessionTreeWatchState(ROOT, 'live')
    await readerFor(ROOT).readDirectory(ROOT)

    applySessionTreeWatchState(ROOT, 'reset')
    await readerFor(ROOT).readDirectory(ROOT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(SESSION_TREE_SAFETY_WALK_INTERVAL_MS)
    await readerFor(ROOT).readDirectory(ROOT)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(3)

    applySessionTreeWatchState(ROOT, 'lost')
    await readerFor(ROOT).readDirectory(ROOT)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(5)
    // A lost watch is asked for again only after the retry interval.
    expect(requests).toEqual([])
    vi.advanceTimersByTime(SESSION_TREE_WATCH_RETRY_INTERVAL_MS)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(requests).toEqual([ROOT])
  })

  it('ignores changes and resets for a root that is not live', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(ROOT, 'reset')
    applySessionTreeChanges(ROOT, [{ type: 'delete', path: PROJECT }])
    await readerFor(ROOT).readDirectory(ROOT)
    await readerFor(ROOT).readDirectory(ROOT)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)
  })
})
