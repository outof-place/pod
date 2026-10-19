// @vitest-environment happy-dom
// Fork-only (Pod): an invalid regex in the terminal's Find. @xterm/addon-search 0.17 compiles the
// term with `RegExp(term, 'g' | 'gi')` and no guard, so with Regex on a pattern like `(` threw out of
// findNext: from TerminalSearch's effect into the terminal's error boundary, and from ⌘G's
// runTerminalSearchNavigation. It must find nothing and mark the field instead.

import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalSearch from '@/components/TerminalSearch'
import { safeFind } from '@/components/terminal-search-safe-find'
import { runTerminalSearchNavigation } from '@/components/terminal-pane/terminal-keyboard-shortcut-matching'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

type FindOptions = { caseSensitive?: boolean; regex?: boolean }

/** The addon's own compile step (SearchEngine.ts:317), so the stub throws where the addon does. */
function addonFind(term: string, options?: FindOptions): boolean {
  if (options?.regex) {
    RegExp(term, options.caseSensitive ? 'g' : 'gi')
  }
  return term.length > 0
}

function createSearchAddon() {
  const stub = {
    findNext: vi.fn(addonFind),
    findPrevious: vi.fn(addonFind),
    clearDecorations: vi.fn(),
    onDidChangeResults: () => ({ dispose: vi.fn() })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The stub implements every addon member TerminalSearch and the navigation use.
  return stub as unknown as SearchAddon
}

describe('an invalid terminal-search regex', () => {
  it('finds nothing through safeFind instead of throwing the addon SyntaxError', () => {
    const find = vi.fn(addonFind)
    expect(() => safeFind(find, '(', { regex: true })).not.toThrow()
    expect(safeFind(find, '(', { regex: true })).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })

  it('still searches a valid regex, and the same text as a literal with Regex off', () => {
    const find = vi.fn(addonFind)
    expect(safeFind(find, 'a+', { regex: true })).toBe(true)
    expect(safeFind(find, '(', { regex: false })).toBe(true)
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('finds nothing on ⌘G navigation instead of throwing', () => {
    const searchAddon = createSearchAddon()
    const state = { query: '[', caseSensitive: false, regex: true }
    expect(() => runTerminalSearchNavigation({ searchAddon }, 'next', state)).not.toThrow()
    expect(runTerminalSearchNavigation({ searchAddon }, 'previous', state)).toBe(false)
    expect(searchAddon.findNext).not.toHaveBeenCalled()
    expect(searchAddon.findPrevious).not.toHaveBeenCalled()
  })

  it('shows no results and an invalid field in the panel, with no throw', () => {
    const searchAddon = createSearchAddon()
    const searchStateRef = { current: { query: '', caseSensitive: false, regex: false } }
    const view = render(
      <TerminalSearch
        isOpen
        onClose={vi.fn()}
        searchAddon={searchAddon}
        searchStateRef={searchStateRef}
      />
    )
    const input = view.getByPlaceholderText('Search...')
    fireEvent.change(input, { target: { value: '(' } })
    fireEvent.click(view.getByTitle('Regex'))
    expect(view.getByText('No results')).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    // The reason a screen reader hears with the invalid mark.
    expect(input.getAttribute('title')).toBe('Invalid regular expression')
    // Typed with Regex off it was a literal search; with Regex on it is never handed to the addon.
    const regexCalls = vi
      .mocked(searchAddon.findNext)
      .mock.calls.filter(([, options]) => options?.regex)
    expect(regexCalls.some(([term]) => term === '(')).toBe(false)
    // ⌘G reads the same state: the query stays as typed, the navigation finds nothing.
    expect(searchStateRef.current).toEqual({ query: '(', caseSensitive: false, regex: true })
    // A valid pattern clears the mark and searches again.
    fireEvent.change(input, { target: { value: '(a)' } })
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
    expect(input.getAttribute('title')).toBeNull()
    expect(searchAddon.findNext).toHaveBeenCalledWith(
      '(a)',
      expect.objectContaining({ regex: true })
    )
  })
})
