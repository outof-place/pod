import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readRepoCheckoutRealPath,
  readRepoCheckoutRealPaths,
  repoCheckoutRealPathIn
} from './repo-checkout-real-path'

describe('repo checkout real paths', () => {
  let base: string
  let link: string
  let real: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pod-checkout-real-path-')))
    real = join(base, 'real')
    mkdirSync(real)
    link = join(base, 'link')
    symlinkSync(real, link)
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('reads the real path of a local repo added through a symlink', async () => {
    const local = { path: link }

    expect(await readRepoCheckoutRealPath(local)).toBe(real)
    const paths = await readRepoCheckoutRealPaths([local, { path: join(base, 'gone') }])
    expect([...paths]).toEqual([[link, real]])
    expect(repoCheckoutRealPathIn(local, paths)).toBe(real)
  })

  it('never resolves an SSH repo path locally, even where the same path is a local symlink', async () => {
    const ssh = { path: link, connectionId: 'build-box' }
    const runtimeHost = { path: link, executionHostId: 'runtime:env-1' as const }

    expect(await readRepoCheckoutRealPath(ssh)).toBeUndefined()
    expect(await readRepoCheckoutRealPath(runtimeHost)).toBeUndefined()
    expect((await readRepoCheckoutRealPaths([ssh, runtimeHost])).size).toBe(0)
    // A local repo at the same path string read it; the SSH repo still gets none.
    const paths = await readRepoCheckoutRealPaths([{ path: link }])
    expect(repoCheckoutRealPathIn(ssh, paths)).toBeUndefined()
  })

  it('reads nothing for a path that is gone', async () => {
    expect(await readRepoCheckoutRealPath({ path: join(base, 'gone') })).toBeUndefined()
  })
})
