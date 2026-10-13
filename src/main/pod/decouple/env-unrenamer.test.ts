import { describe, expect, it } from 'vitest'
import { createEnvUnrenamer } from '../../../../product/scripts/pod-decouple.mjs'

// Names built from the two prefixes, so the codemod leaves this test's meaning alone.
const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
const current = (name: string): string => `${SPELLINGS.current}${name}`
const legacy = (name: string): string => `${SPELLINGS.legacy}${name}`

describe('the env stage backwards (tests of code from before the decouple)', () => {
  const unrename = createEnvUnrenamer()

  it('spells each renamed name the ORCA_ way again', () => {
    expect(
      unrename(`const handle = env.${current('TERMINAL_HANDLE')}\n"$${current('PANE_KEY')}"`)
    ).toBe(`const handle = env.${legacy('TERMINAL_HANDLE')}\n"$${legacy('PANE_KEY')}"`)
  })

  it('leaves Pod-only names, longer tokens and keep lines alone', () => {
    const text = [
      `getenv("${current('AGENT_HOOK_BINARY')}")`,
      `X${current('TERMINAL_HANDLE')}_TAIL`,
      `env.${current('TERMINAL_HANDLE')} // pod-decouple:keep`
    ].join('\n')
    expect(unrename(text)).toBe(text)
  })
})
