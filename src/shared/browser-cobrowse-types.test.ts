import { describe, expect, it } from 'vitest'
import { formatCobrowseMarksMarkdown, type CobrowseMark } from './browser-cobrowse-types'

const mark = (n: number, element: CobrowseMark['element']): CobrowseMark => ({
  id: `mark-${n}`,
  n,
  browserPageId: 'page-1',
  url: 'http://localhost:5173/shop',
  title: 'Shop',
  note: 'Label is cut off',
  createdAt: '2026-10-18T12:00:00Z',
  kind: 'element',
  element,
  box: { x: 700, y: 140, width: 160, height: 36 },
  pageBox: { x: 700, y: 140, width: 160, height: 36 },
  viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0 },
  replyTo: [],
  screenshot: null
})

describe('a mark as Markdown', () => {
  it('tells the agent how to point back at it, a mark in an iframe included', () => {
    const markdown = formatCobrowseMarksMarkdown([
      mark(3, {
        tag: 'button',
        selector: 'button#frame-buy',
        role: 'button',
        name: 'Buy in frame',
        text: 'Buy in frame',
        html: '<button id="frame-buy">Buy in frame</button>',
        frameUrl: 'http://localhost:5173/cobrowse-frame.html',
        inShadowRoot: false
      })
    ])
    expect(markdown).toContain(
      '- In the iframe http://localhost:5173/cobrowse-frame.html: the locator is unique inside it'
    )
    expect(markdown).toContain('- Point back at it: `point --mark 3`')
  })
})
