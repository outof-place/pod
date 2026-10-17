import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Why: Pod replaces an installed helper only for a higher VERSION, so changed sources under the
// same VERSION would never reach a Mac that already has it.
const MODULE = join(__dirname, '../../../../native/pod-gocache-macos')
const stamp: unknown = createRequire(import.meta.url)(join(MODULE, 'scripts/stamp-version.cjs'))

function call<T>(name: string, ...args: unknown[]): T {
  const fn: unknown = Reflect.get(Object(stamp), name)
  if (typeof fn !== 'function') {
    throw new Error(`stamp-version.cjs exports no ${name}`)
  }
  return Reflect.apply(fn, undefined, args)
}

const problems = (dir?: string): string[] => call('stampProblems', dir)
const stampVersion = (dir: string): string | null => call('stampVersion', dir)

const roots: string[] = []

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('pod-gocache VERSION', () => {
  it('is stamped for the helper sources in this tree', () => {
    expect(problems()).toEqual([])
  })

  it('goes stale on a source change only, and re-stamps only after a bump', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-gocache-stamp-'))
    roots.push(root)
    write(root, 'go.mod', 'module example.com/fixture\n')
    write(root, 'cmd/pod-gocache/main.go', 'package main\n')
    write(root, 'cmd/pod-gocache/main_test.go', 'package main\n')
    write(root, 'bench/bench.go', 'package bench\n')
    write(root, 'internal/x/testdata/fixture.go', 'package fixture\n')
    write(root, 'scripts/VERSION', '0.1.0\n')
    expect(problems(root)).toEqual([expect.stringMatching(/missing/)])
    expect(stampVersion(root)).toBeNull()

    write(root, 'cmd/pod-gocache/main_test.go', 'package main // more tests\n')
    write(root, 'bench/bench.go', 'package bench // tuned\n')
    write(root, 'internal/x/testdata/fixture.go', 'package fixture // edited\n')
    expect(problems(root)).toEqual([])

    write(root, 'cmd/pod-gocache/main.go', 'package main // changed\n')
    expect(problems(root)).toEqual([expect.stringMatching(/bump scripts\/VERSION/)])
    expect(stampVersion(root)).toMatch(/bump scripts\/VERSION first/)

    write(root, 'scripts/VERSION', '0.1.1\n')
    expect(stampVersion(root)).toBeNull()
    expect(problems(root)).toEqual([])
  })
})
