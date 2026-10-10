import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const gate: { bytecodeWrittenAfter(dir: string, since: number): string[] } =
  await import('../../../product/scripts/verify-bundle-seal.mjs')

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('bundle seal gate', () => {
  it('lists bytecode written after the probes started, not bytecode the bundle shipped', () => {
    root = mkdtempSync(join(tmpdir(), 'pod-seal-gate-'))
    const resources = join(root, 'Pod.app/Contents/Resources')
    mkdirSync(join(resources, 'claude-acc/__pycache__'), { recursive: true })
    mkdirSync(join(resources, 'python/lib'), { recursive: true })
    writeFileSync(join(resources, 'python/lib/shipped.pyc'), '')
    writeFileSync(join(resources, 'claude-acc/orcahost.py'), '')
    const since = Date.now() - 60_000
    const old = new Date(since - 60_000)
    utimesSync(join(resources, 'python/lib/shipped.pyc'), old, old)
    expect(gate.bytecodeWrittenAfter(root, since)).toEqual([
      join(resources, 'claude-acc/__pycache__')
    ])
  })
})
