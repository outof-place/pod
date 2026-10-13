import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', '..', 'product', 'scripts', 'pod-build-number.sh')

function buildNumber(version: string): { status: number | null; out: string } {
  const result = spawnSync('/bin/bash', [script, version], {
    encoding: 'utf8'
  })
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`.trim()
  }
}

describe('pod-build-number.sh', () => {
  it('gives the release table its CFBundleVersions', () => {
    expect(buildNumber('1.0.0-rc1')).toEqual({ status: 0, out: '1000001' })
    expect(buildNumber('1.0.0-rc2')).toEqual({ status: 0, out: '1000002' })
    expect(buildNumber('1.0.0')).toEqual({ status: 0, out: '1000099' })
    expect(buildNumber('1.0.1-rc1')).toEqual({ status: 0, out: '1000101' })
    expect(buildNumber('1.2.3')).toEqual({ status: 0, out: '1020399' })
  })

  it('grows with every release, so Sparkle offers each one over the last', () => {
    const order = [
      '0.9.99',
      '1.0.0-rc1',
      '1.0.0-rc98',
      '1.0.0',
      '1.0.1-rc1',
      '1.0.1',
      '1.1.0-rc1',
      '2.0.0-rc1'
    ]
    const numbers = order.map((version) => Number(buildNumber(version).out))
    expect(numbers.every((n, i) => i === 0 || n > numbers[i - 1])).toBe(true)
  })

  it('refuses a version the number cannot order', () => {
    for (const version of [
      '1.0',
      'v1.0.0',
      '1.0.0-beta1',
      '1.0.0-rc0',
      '1.0.0-rc99',
      '1.100.0',
      '1.0.100'
    ]) {
      expect(buildNumber(version).status, version).toBe(2)
    }
  })
})
