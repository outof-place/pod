import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addTimeMachineExclusions,
  detectSpotlightState,
  excludeMissingBuildDirs,
  readBuildDirExclusions,
  readTimeMachineDestination,
  readTimeMachineExclusions,
  TMUTIL_BATCH_SIZE
} from './workspace-hygiene'
import type { WorkspaceToolResult, WorkspaceToolRunner } from './workspace-tool-runner'

const ok = (stdout: string): WorkspaceToolResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false
})

/** Fake tmutil keeping an exclusion set, like the real xattr. */
function fakeTmutil(initiallyExcluded: string[] = []) {
  const excluded = new Set(initiallyExcluded)
  const calls: string[][] = []
  const run: WorkspaceToolRunner = vi.fn(async (tool, args) => {
    calls.push([tool, ...args])
    if (tool !== 'tmutil') {
      return ok('')
    }
    const [verb, ...paths] = args
    if (verb === 'isexcluded') {
      return ok(
        paths
          .map((path) => `${excluded.has(path) ? '[Excluded]' : '[Included]'}  ${path}`)
          .join('\n')
      )
    }
    if (verb === 'addexclusion') {
      for (const path of paths) {
        excluded.add(path)
      }
      return ok('')
    }
    return ok('')
  })
  return { run, calls, excluded }
}

const dirs: string[] = []
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pod-hygiene-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Time Machine exclusions', () => {
  it('batches isexcluded and maps answers by argument order', async () => {
    const paths = Array.from({ length: TMUTIL_BATCH_SIZE + 3 }, (_, index) => `/r/p${index}`)
    const tm = fakeTmutil(['/r/p1'])
    const states = await readTimeMachineExclusions(tm.run, paths)
    expect(tm.calls.filter((call) => call[1] === 'isexcluded')).toHaveLength(2)
    expect(states.get('/r/p1')).toBe('excluded')
    expect(states.get('/r/p0')).toBe('included')
  })

  it('reads UNKNOWN lines and missing answers as unknown', async () => {
    const run: WorkspaceToolRunner = async () => ok('[UNKNOWN]   /r/gone')
    const states = await readTimeMachineExclusions(run, ['/r/gone', '/r/other'])
    expect(states.get('/r/gone')).toBe('unknown')
    expect(states.get('/r/other')).toBe('unknown')
  })

  it('counts only exclusions that tmutil confirms afterwards', async () => {
    const tm = fakeTmutil()
    const stubborn: WorkspaceToolRunner = async (tool, args, options) =>
      args[0] === 'addexclusion'
        ? tm.run(tool, [args[0], ...args.slice(1).filter((path) => path !== '/r/locked')], options)
        : tm.run(tool, args, options)
    const result = await addTimeMachineExclusions(stubborn, ['/r/a', '/r/locked'])
    expect(result).toEqual({ excluded: ['/r/a'], failed: ['/r/locked'] })
  })

  it('tells a missing backup disk from a configured one', async () => {
    expect(
      await readTimeMachineDestination(async () => ({
        code: 0,
        stdout: '',
        stderr: 'tmutil: No destinations configured.',
        timedOut: false
      }))
    ).toBe('none')
    expect(
      await readTimeMachineDestination(async () =>
        ok(
          '====================================================\nName          : Backup\nKind          : Local\n'
        )
      )
    ).toBe('configured')
    expect(
      await readTimeMachineDestination(async () => ({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: true
      }))
    ).toBe('unknown')
  })

  it('finds shallow build dirs, honours manifests, and excludes only the missing ones', async () => {
    const repo = tempRepo()
    mkdirSync(join(repo, 'node_modules'))
    mkdirSync(join(repo, 'target'))
    mkdirSync(join(repo, '.build'))
    writeFileSync(join(repo, 'Package.swift'), '')
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "!apps/skip"\n')
    mkdirSync(join(repo, 'apps', 'web', '.next'), { recursive: true })
    mkdirSync(join(repo, 'apps', 'web', 'src', 'node_modules'), { recursive: true })
    const tm = fakeTmutil([join(repo, 'node_modules')])

    const before = await readBuildDirExclusions(tm.run, [repo])
    expect(before.excluded).toEqual([join(repo, 'node_modules')])
    // `target` has no Cargo.toml beside it; the nested src/node_modules is past the shallow scan.
    expect(before.missing.sort()).toEqual(
      [join(repo, '.build'), join(repo, 'apps', 'web', '.next')].sort()
    )

    const result = await excludeMissingBuildDirs(tm.run, [repo])
    expect(result.failed).toEqual([])
    expect(result.excluded.sort()).toEqual(before.missing.sort())
    expect(tm.calls.filter((call) => call[1] === 'addexclusion')).toHaveLength(1)
  })

  it('spawns nothing when a checkout has no build dirs', async () => {
    const tm = fakeTmutil()
    expect(await excludeMissingBuildDirs(tm.run, [tempRepo()])).toEqual({
      excluded: [],
      failed: []
    })
    expect(tm.calls).toEqual([])
  })
})

describe('detectSpotlightState', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')
  const old = { mtimeMs: now - 3 * 60 * 60 * 1000, ctimeMs: now - 3 * 60 * 60 * 1000 }
  const fresh = { mtimeMs: now - 60_000, ctimeMs: now - 60_000 }

  function spotlightRunner(hits: Record<string, string>, indexing = 'Indexing enabled.') {
    return vi.fn<WorkspaceToolRunner>(async (tool, args) => {
      if (tool === 'mdutil') {
        return ok(`/:\n\t${indexing}\n`)
      }
      return ok(hits[args[1]] ?? '')
    })
  }

  const base = {
    repoPaths: ['/pod/a/one', '/pod/b/two'],
    listTrackedRootFiles: async () => ['README.md'],
    now,
    statTimes: async () => old
  }

  it('reports indexed on any hit', async () => {
    const run = spotlightRunner({ '/pod/b/two': '/pod/b/two/README.md\n' })
    expect((await detectSpotlightState({ ...base, run })).state).toBe('indexed')
  })

  it('reports excluded when every probe answers with no hits', async () => {
    const run = spotlightRunner({})
    const result = await detectSpotlightState({ ...base, run })
    expect(result.state).toBe('excluded')
    expect(run.mock.calls.filter(([tool]) => tool === 'mdfind')).toHaveLength(2)
  })

  it('is unknown with no old files, with indexing off, or when mdfind fails', async () => {
    expect(
      await detectSpotlightState({
        ...base,
        run: spotlightRunner({}),
        statTimes: async () => fresh
      })
    ).toMatchObject({ state: 'unknown', reason: 'no-old-files' })
    expect(
      await detectSpotlightState({ ...base, run: spotlightRunner({}, 'Indexing disabled.') })
    ).toMatchObject({ state: 'unknown', reason: 'indexing-disabled' })
    const failing: WorkspaceToolRunner = async (tool) =>
      tool === 'mdutil'
        ? ok('Indexing enabled.')
        : { code: null, stdout: '', stderr: '', timedOut: true }
    expect(await detectSpotlightState({ ...base, run: failing })).toMatchObject({
      state: 'unknown',
      reason: 'error'
    })
  })

  it('probes at most three repos with a fixed query and a 3 s timeout', async () => {
    const run = spotlightRunner({})
    await detectSpotlightState({
      ...base,
      repoPaths: ['/p/1', '/p/2', '/p/3', '/p/4', '/p/5'],
      run
    })
    const mdfindCalls = run.mock.calls.filter(([tool]) => tool === 'mdfind')
    expect(mdfindCalls).toHaveLength(3)
    expect(mdfindCalls[0][1]).toEqual(['-onlyin', '/p/1', 'kMDItemFSName == "README.md"'])
    expect(mdfindCalls[0][2]).toEqual({ timeoutMs: 3_000 })
  })
})
