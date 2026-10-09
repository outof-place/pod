import { constants } from 'node:module'
import { describe, expect, it } from 'vitest'
import { enableMainProcessCompileCache } from './main-process-compile-cache'

const { ALREADY_ENABLED, DISABLED, ENABLED, FAILED } = constants.compileCacheStatus

describe('enableMainProcessCompileCache', () => {
  it.each([
    [ENABLED, true],
    [ALREADY_ENABLED, true],
    [DISABLED, false],
    [FAILED, false]
  ])('maps status %i to %s', (status, expected) => {
    expect(enableMainProcessCompileCache(() => ({ status }))).toBe(expected)
  })

  it('reports the cache as off instead of failing launch when Node throws', () => {
    expect(
      enableMainProcessCompileCache(() => {
        throw new Error('EACCES')
      })
    ).toBe(false)
  })
})
