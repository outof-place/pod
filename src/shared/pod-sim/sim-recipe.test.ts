import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseOrcaYaml } from '../orca-yaml'
import { parseSimRecipe } from './sim-recipe'

const Expected = z.array(
  z.object({ path: z.string(), severity: z.enum(['error', 'warning']) }).strict()
)
const Case = z.object({ name: z.string(), simulators: z.unknown(), diagnostics: Expected }).strict()
const fixture = z
  .object({ valid: z.array(Case), invalid: z.array(Case) })
  .strict()
  .parse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'recipes.json'), 'utf8')))

const shape = (diagnostics: readonly { path: string; severity: string }[]) =>
  diagnostics.map(({ path, severity }) => ({ path, severity }))

describe('orca.yaml simulators: recipes', () => {
  for (const testCase of fixture.valid) {
    it(`accepts ${testCase.name}`, () => {
      const parsed = parseSimRecipe(testCase.simulators)
      expect(parsed.recipe).not.toBeNull()
      expect(shape(parsed.diagnostics)).toEqual(testCase.diagnostics)
      for (const diagnostic of parsed.diagnostics) {
        expect(diagnostic.message.length).toBeGreaterThan(0)
      }
    })
  }

  for (const testCase of fixture.invalid) {
    it(`refuses ${testCase.name}, naming the key`, () => {
      const parsed = parseSimRecipe(testCase.simulators)
      expect(parsed.recipe).toBeNull()
      expect(shape(parsed.diagnostics)).toEqual(testCase.diagnostics)
    })
  }

  it('keeps every field of the full recipe', () => {
    const [full] = fixture.valid
    expect(parseSimRecipe(full?.simulators).recipe).toEqual(full?.simulators)
  })
})

// The owed stage-1 lookup: runtimes from before this contract must ignore the new section.
describe('an orca.yaml with simulators: in a runtime that predates it', () => {
  const simulators = [
    'simulators:',
    '  apps:',
    '    mobile:',
    '      bundleId: eu.portivo.app',
    '      path: apps/mobile'
  ].join('\n')

  it('reads as no project defaults when the section is all there is', () => {
    expect(parseOrcaYaml(`${simulators}\n`)).toBeNull()
  })

  it('keeps the rest of the file unchanged', () => {
    const scripts = 'scripts:\n  setup: pnpm install\n'
    expect(parseOrcaYaml(`${scripts}${simulators}\n`)).toEqual(parseOrcaYaml(scripts))
  })
})
