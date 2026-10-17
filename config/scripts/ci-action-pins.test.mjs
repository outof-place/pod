// Fork-only (Pod): every action Pod's runner executes is pinned by commit (config/scripts/ci-action-pins.mjs).
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CI_ACTION_PINS } from './ci-action-pins.mjs'

const files = [...globSync('.github/actions/*/action.yml'), '.github/workflows/pod-check.yml']

function stepsOf(file) {
  const parsed = parse(readFileSync(file, 'utf8'))
  return [
    ...(parsed.runs?.steps ?? []),
    ...Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? [])
  ]
}

describe('CI action pins', () => {
  it.each(files)('%s runs third-party actions only at a full commit', (file) => {
    for (const { uses } of stepsOf(file)) {
      if (!uses || uses.startsWith('./')) {
        continue
      }
      expect(uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
    }
  })

  it('pins each listed action to the commit the composite actions use', () => {
    const used = new Map()
    for (const file of files) {
      for (const { uses } of stepsOf(file)) {
        const match = /^([\w.-]+\/[\w.-]+)[\w./-]*@([0-9a-f]{40})$/.exec(uses ?? '')
        if (match && match[1] in CI_ACTION_PINS) {
          used.set(match[1], [...(used.get(match[1]) ?? []), match[2]])
        }
      }
    }
    for (const [name, sha] of Object.entries(CI_ACTION_PINS)) {
      expect(used.get(name)?.length).toBeGreaterThan(0)
      expect(new Set(used.get(name))).toEqual(new Set([sha]))
    }
  })
})
