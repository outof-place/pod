import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFiles } from './session-scanner-discovery'
import {
  applySessionTreeChanges,
  applySessionTreeWatchState,
  forgetSessionTreePaths,
  installSessionTreeWatchRequests,
  refreshSessionTreeCache,
  resetSessionTreeCacheForTests
} from './session-tree-cache'

let root: string

async function discovered(scanRoot = root): Promise<string[]> {
  const discovery = await discoverFiles({
    rootDir: scanRoot,
    limit: 100,
    agent: 'claude',
    issues: [],
    extensions: ['.jsonl'],
    directoryPredicate: (name) => name !== 'subagents'
  })
  return discovery.files.map((file) => file.path.slice(scanRoot.length + 1)).sort()
}

beforeEach(async () => {
  resetSessionTreeCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-session-tree-'))
  await mkdir(join(root, 'proj', 'subagents'), { recursive: true })
  await writeFile(join(root, 'proj', 'a.jsonl'), '{}\n')
  await writeFile(join(root, 'proj', 'subagents', 'agent.jsonl'), '{}\n')
})

afterEach(async () => {
  resetSessionTreeCacheForTests()
  await rm(root, { recursive: true, force: true })
})

describe('discoverFiles over a watched root', () => {
  it('asks the host to watch a root it walked', async () => {
    const requests: string[] = []
    installSessionTreeWatchRequests((requested) => requests.push(requested))
    expect(await discovered()).toEqual(['proj/a.jsonl'])
    expect(requests).toEqual([root])
  })

  it('reflects exactly the changes the watcher reported', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(root, 'live')
    expect(await discovered()).toEqual(['proj/a.jsonl'])

    const added = join(root, 'proj', 'b.jsonl')
    await writeFile(added, '{}\n')
    // Unreported, so the cached listing still stands: the walk did not touch disk.
    expect(await discovered()).toEqual(['proj/a.jsonl'])
    applySessionTreeChanges(root, [{ type: 'create', path: added }])
    expect(await discovered()).toEqual(['proj/a.jsonl', 'proj/b.jsonl'])

    await utimes(added, new Date(5_000), new Date(5_000))
    applySessionTreeChanges(root, [{ type: 'update', path: added }])
    const discovery = await discoverFiles({
      rootDir: root,
      limit: 100,
      agent: 'claude',
      issues: [],
      extensions: ['.jsonl']
    })
    expect(discovery.files.find((file) => file.path === added)?.mtimeMs).toBe(5_000)
  })

  it('never lists a file the host reported deleted', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(root, 'live')
    expect(await discovered()).toEqual(['proj/a.jsonl'])

    const deleted = join(root, 'proj', 'a.jsonl')
    await rm(deleted)
    forgetSessionTreePaths([deleted])
    expect(await discovered()).toEqual([])
  })

  it('rereads descendants when a directory update summarizes their changes', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(root, 'live')
    await mkdir(join(root, 'proj', 'nested'))
    const nested = join(root, 'proj', 'nested', 'old.jsonl')
    await writeFile(nested, '{}\n')
    expect(await discovered()).toEqual(['proj/a.jsonl', 'proj/nested/old.jsonl'])

    await utimes(nested, new Date(5_000), new Date(5_000))
    await writeFile(join(root, 'proj', 'nested', 'new.jsonl'), '{}\n')
    applySessionTreeChanges(root, [{ type: 'update', path: join(root, 'proj') }])

    const discovery = await discoverFiles({
      rootDir: root,
      limit: 100,
      agent: 'claude',
      issues: [],
      extensions: ['.jsonl'],
      directoryPredicate: (name) => name !== 'subagents'
    })
    expect(discovery.files.find((file) => file.path === nested)?.mtimeMs).toBe(5_000)
    expect(
      discovery.files.some((file) => file.path === join(root, 'proj', 'nested', 'new.jsonl'))
    ).toBe(true)
  })

  it('rebinds a retargeted symlink before trusting any cached paths', async () => {
    const alias = join(root, 'alias')
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'b.jsonl'), '{}\n')
    await symlink(join(root, 'proj'), alias, 'junction')
    const requests: { root: string; restart?: boolean }[] = []
    installSessionTreeWatchRequests((root, restart) => requests.push({ root, restart }))
    applySessionTreeWatchState(alias, 'live', await stat(alias))
    expect(await discovered(alias)).toEqual(['a.jsonl'])

    await rm(alias)
    await symlink(other, alias, 'junction')
    expect(await discovered(alias)).toEqual(['b.jsonl'])
    expect(requests).toEqual([{ root: alias, restart: true }])

    applySessionTreeWatchState(alias, 'live', await stat(alias))
    expect(await discovered(alias)).toEqual(['b.jsonl'])
    await writeFile(join(other, 'c.jsonl'), '{}\n')
    applySessionTreeChanges(alias, [{ type: 'create', path: join(alias, 'c.jsonl') }])
    expect(await discovered(alias)).toEqual(['b.jsonl', 'c.jsonl'])
  })

  it('allows an explicit refresh to find a change whose watcher event was missed', async () => {
    installSessionTreeWatchRequests(() => undefined)
    applySessionTreeWatchState(root, 'live')
    expect(await discovered()).toEqual(['proj/a.jsonl'])
    await writeFile(join(root, 'proj', 'b.jsonl'), '{}\n')
    expect(await discovered()).toEqual(['proj/a.jsonl'])

    refreshSessionTreeCache()
    expect(await discovered()).toEqual(['proj/a.jsonl', 'proj/b.jsonl'])
  })
})
