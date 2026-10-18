import { beforeEach, describe, expect, it, vi } from 'vitest'

const printed = vi.hoisted(() => ({ text: '' }))
vi.mock('../format', () => ({
  printResult: (response: { result: unknown }, _json: boolean, format: (v: unknown) => string) => {
    printed.text = format(response.result)
  }
}))
vi.mock('../selectors', () => ({ getBrowserCommandTarget: async () => ({ page: 'page-1' }) }))

import { BROWSER_COBROWSE_HANDLERS } from './browser-cobrowse'
import { RuntimeClientError } from '../runtime-client'
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

function runPoint(flags: [string, string | boolean][]): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: point reads only flags, client, cwd and json.
  const context = {
    flags: new Map(flags),
    client: { call },
    cwd: '/',
    json: false
  } as unknown as Parameters<CommandHandler>[0]
  return Promise.resolve(BROWSER_COBROWSE_HANDLERS.point(context))
}

describe('point --mark', () => {
  beforeEach(() => {
    call.mockReset().mockResolvedValue({
      id: 'r1',
      result: { browserPageId: 'page-1', pointerId: 'p1', box: null, shown: true, cleared: 0 }
    })
  })

  it("asks the runtime for the mark's own element by its number", async () => {
    await runPoint([
      ['mark', '3'],
      ['label', 'This label?']
    ])
    expect(call).toHaveBeenCalledWith('browser.point', {
      mark: 3,
      label: 'This label?',
      keep: false,
      page: 'page-1'
    })
    expect(printed.text).toBe('Pointing at mark 3: the user sees it')
  })

  it('takes one target: a mark, an element or a region', async () => {
    await expect(
      runPoint([
        ['mark', '3'],
        ['element', '#save']
      ])
    ).rejects.toThrow('one of --mark, --element or a region')
    expect(call).not.toHaveBeenCalled()
  })

  it('says when the user sees an arrow toward it rather than a ring', async () => {
    call.mockResolvedValue({
      id: 'r1',
      result: {
        browserPageId: 'page-1',
        pointerId: 'p1',
        box: null,
        shown: true,
        cleared: 0,
        outOfSight: true
      }
    })
    await runPoint([['element', 'li#item-10']])
    expect(printed.text).toBe(
      'Pointing at li#item-10: it is out of sight now (scrolled away), so the user sees an arrow toward it'
    )
  })

  it('a runtime that cannot point at marks says to update Pod or use the locator', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return { id: 's', result: { capabilities: ['pod.browser.cobrowse.v1'] } }
      }
      throw new RuntimeClientError('invalid_argument', 'Point at --element <selector or @ref>')
    })
    await expect(runPoint([['mark', '3']])).rejects.toThrow(
      'This Pod runtime cannot point at a mark yet; update Pod, or point with --element and the mark locator.'
    )
  })
})
