import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { SessionTreeCacheBudget } from './session-tree-cache-budget'
import { WatchedSessionTree } from './session-watched-tree'

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedReaddir: fsMocks.readdir,
  wslGatedStat: fsMocks.stat
}))

function entry(name: string): Dirent {
  return {
    name,
    parentPath: '',
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}

beforeEach(() => {
  fsMocks.readdir.mockReset().mockResolvedValue([entry('a.jsonl'), entry('b.jsonl')])
  fsMocks.stat.mockReset().mockResolvedValue({ mtimeMs: 1, size: 10, dev: 1, ino: 2, nlink: 1 })
})

describe('watched tree cache admission', () => {
  it('shares its ceiling across roots and reads overflowing paths from disk', async () => {
    const budget = new SessionTreeCacheBudget(6)
    const firstRoot = join('/', 'first')
    const secondRoot = join('/', 'second')
    const first = new WatchedSessionTree(firstRoot, Date.now(), budget)
    const second = new WatchedSessionTree(secondRoot, Date.now(), budget)
    await first.readDirectory(firstRoot)
    await first.stat(join(firstRoot, 'a.jsonl'))
    await second.readDirectory(secondRoot)
    await second.stat(join(secondRoot, 'a.jsonl'))

    const overflow = join(secondRoot, 'b.jsonl')
    await second.stat(overflow)
    await second.stat(overflow)
    expect(fsMocks.stat).toHaveBeenCalledTimes(4)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)

    first.apply({ type: 'delete', path: join(firstRoot, 'a.jsonl') }, Date.now())
    await second.stat(overflow)
    await second.stat(overflow)
    expect(fsMocks.stat).toHaveBeenCalledTimes(5)
    await second.readDirectory(secondRoot)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)
  })

  it('does not retain an oversized directory listing or refuse its results', async () => {
    const root = join('/', 'root')
    const tree = new WatchedSessionTree(root, Date.now(), new SessionTreeCacheBudget(1))
    expect((await tree.readDirectory(root)).map((entry) => entry.name)).toEqual([
      'a.jsonl',
      'b.jsonl'
    ])
    expect((await tree.readDirectory(root)).map((entry) => entry.name)).toEqual([
      'a.jsonl',
      'b.jsonl'
    ])
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)
  })

  it('releases subtree admission when a directory is deleted or reset', async () => {
    const root = join('/', 'root')
    const tree = new WatchedSessionTree(root, Date.now(), new SessionTreeCacheBudget(3))
    const directory = join(root, 'project')
    await tree.readDirectory(directory)
    tree.apply({ type: 'delete', path: directory }, Date.now())
    await tree.readDirectory(directory)
    await tree.readDirectory(directory)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2)

    tree.reset(Date.now())
    await tree.readDirectory(directory)
    await tree.readDirectory(directory)
    expect(fsMocks.readdir).toHaveBeenCalledTimes(3)
  })

  it('bounds long names by estimated retained bytes across roots', async () => {
    const budget = new SessionTreeCacheBudget(100, 600)
    const firstRoot = join('/', 'first')
    const secondRoot = join('/', 'second')
    const first = new WatchedSessionTree(firstRoot, Date.now(), budget)
    const second = new WatchedSessionTree(secondRoot, Date.now(), budget)
    const longName = `${'a'.repeat(120)}.jsonl`
    const firstPath = join(firstRoot, longName)
    const secondPath = join(secondRoot, longName)
    await first.stat(firstPath)
    await first.stat(firstPath)
    await second.stat(secondPath)
    await second.stat(secondPath)
    expect(fsMocks.stat).toHaveBeenCalledTimes(3)

    first.dispose()
    await second.stat(secondPath)
    await second.stat(secondPath)
    expect(fsMocks.stat).toHaveBeenCalledTimes(4)
  })
})
