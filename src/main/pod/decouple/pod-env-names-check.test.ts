// Fork-only (Pod): a new ORCA_ env name must be filed before it ships, since the POD_ aliases
// come from the table (product/scripts/pod-env-names.mjs).
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..', '..', '..')

describe('pod-env-names --check', () => {
  it('finds every ORCA_ env name of the tree filed in env-names.json', () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'product/scripts/pod-env-names.mjs'), '--check'],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  }, 60_000)
})
