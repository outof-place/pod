import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFiles } from './session-scanner-discovery'
import {
  applySessionTreeChanges,
  applySessionTreeWatchState,
  forgetSessionTreePaths,
  installSessionTreeWatchRequests,
  resetSessionTreeCacheForTests
} from './session-tree-cache'

let root: string

async function discovered(): Promise<string[]> {
  const discovery = await discoverFiles({
    rootDir: root,
    limit: 100,
    agent: 'claude',
    issues: [],
    extensions: ['.jsonl'],
    directoryPredicate: (name) => name !== 'subagents'
  })
  return discovery.files.map((file) => file.path.slice(root.length + 1)).sort()
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
})
