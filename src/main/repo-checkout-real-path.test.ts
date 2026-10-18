import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRepoCheckoutRealPath } from './repo-checkout-real-path'

describe('readRepoCheckoutRealPath', () => {
  it('reads a repo once per synchronous pass, and afresh in the next', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'pod-checkout-pass-')))
    try {
      mkdirSync(join(base, 'a'))
      mkdirSync(join(base, 'b'))
      const link = join(base, 'link')
      symlinkSync(join(base, 'a'), link)
      const repo = { path: link }

      expect(readRepoCheckoutRealPath(repo)).toBe(join(base, 'a'))
      symlinkSync(join(base, 'b'), join(base, 'next'))
      renameSync(join(base, 'next'), link)
      expect(readRepoCheckoutRealPath(repo)).toBe(join(base, 'a'))
      await Promise.resolve()
      expect(readRepoCheckoutRealPath(repo)).toBe(join(base, 'b'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('reads nothing for a repo on another host or a path that is gone', () => {
    expect(readRepoCheckoutRealPath({ path: tmpdir(), connectionId: 'build-box' })).toBeUndefined()
    expect(readRepoCheckoutRealPath({ path: join(tmpdir(), 'pod-no-such-repo') })).toBeUndefined()
  })
})
