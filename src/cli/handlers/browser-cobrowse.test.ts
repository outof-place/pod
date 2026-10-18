import { beforeEach, describe, expect, it, vi } from 'vitest'

const printed = vi.hoisted(() => ({ text: '' }))
vi.mock('../format', () => ({
  printResult: (response: { result: unknown }, _json: boolean, format: (v: unknown) => string) => {
    printed.text = format(response.result)
  }
}))
vi.mock('../selectors', () => ({ getBrowserCommandTarget: async () => ({ page: 'page-1' }) }))

import { BROWSER_COBROWSE_HANDLERS } from './browser-cobrowse'
import type { CommandHandler } from '../dispatch'

const call = vi.fn()

function runMarks(flags: [string, string | boolean][]): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marks reads only flags, client, cwd and json.
  const context = {
    flags: new Map(flags),
    client: { call },
    cwd: '/',
    json: false
  } as unknown as Parameters<CommandHandler>[0]
  return Promise.resolve(BROWSER_COBROWSE_HANDLERS.marks(context))
}

describe('marks', () => {
  beforeEach(() => {
    call.mockReset().mockResolvedValue({
      id: 'r1',
      result: { browserPageId: 'page-1', marks: [], timedOut: false }
    })
  })

  it('takes its wait budget in --timeout-ms, as other waits do, and waits past it for the reply', async () => {
    await runMarks([
      ['wait', true],
      ['timeout-ms', '1800000']
    ])
    expect(call).toHaveBeenCalledWith(
      'browser.marks',
      expect.objectContaining({ wait: true, timeout: 1_800_000 }),
      { timeoutMs: 1_805_000 }
    )
  })

  it('says the tab closed when it did', async () => {
    call.mockResolvedValue({
      id: 'r1',
      result: { browserPageId: 'page-1', marks: [], timedOut: false, pageClosed: true }
    })
    await runMarks([['wait', true]])
    expect(printed.text).toBe('No marks: the tab closed before the user sent any.')
  })
})
