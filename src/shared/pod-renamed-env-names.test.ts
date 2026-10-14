import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ENV_SPELLINGS } from './pod-legacy-env-names'
import { RENAMED_ENV_NAMES } from './pod-renamed-env-names'

// Fork-only (Pod): the overlap code's list must be the codemod table's, in either tree.
it('lists exactly the names the pod-decouple table renames, in one spelling', () => {
  const table: { rename: string[] } = JSON.parse(
    readFileSync(join(process.cwd(), 'product/pod-decouple/env-names.json'), 'utf8')
  )
  const asTabled = RENAMED_ENV_NAMES.map((name) =>
    name.startsWith(ENV_SPELLINGS.current)
      ? `${ENV_SPELLINGS.legacy}${name.slice(ENV_SPELLINGS.current.length)}`
      : name
  )
  expect(asTabled).toHaveLength(table.rename.length)
  expect(new Set(asTabled)).toEqual(new Set(table.rename))
  expect(
    new Set(RENAMED_ENV_NAMES.map((name) => name.startsWith(ENV_SPELLINGS.current))).size
  ).toBe(1)
})
