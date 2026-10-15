import { describe, expect, it } from 'vitest'
import { PaneLinks } from './pod-browser-pane-links'
import type { PodBrowserInputEvent, PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import { POD_UI_HOST_MAX_LINE_BYTES } from '../ui-host/pod-ui-host-protocol'

function setup() {
  const sent: PodBrowserPaneServerMessage[] = []
  let now = 1_000_000
  const links = new PaneLinks(
    'page-1',
    (message) => {
      sent.push(message)
      return true
    },
    () => now
  )
  return {
    links,
    sent,
    advance: (ms: number) => {
      now += ms
    }
  }
}

function click(
  button: 'left' | 'right' | 'middle',
  modifiers: ('shift' | 'meta' | 'control' | 'alt')[] = []
): PodBrowserInputEvent[] {
  return (['down', 'up'] as const).map((action) => ({
    kind: 'mouse',
    action,
    x: 10,
    y: 10,
    button,
    clickCount: 1,
    modifiers
  }))
}

describe('PaneLinks hover', () => {
  it('sends the hovered link once, then an empty URL when the pointer leaves it', () => {
    const { links, sent } = setup()
    links.hover('https://example.com/a', true)
    links.hover('https://example.com/a', true)
    links.hover('', true)
    expect(sent).toEqual([
      {
        type: 'browserTargetUrl',
        pageId: 'page-1',
        url: 'https://example.com/a'
      },
      { type: 'browserTargetUrl', pageId: 'page-1', url: '' }
    ])
  })

  it('shows what a page menu would open: normalized, the Kagi token redacted', () => {
    const { links, sent } = setup()
    links.hover('https://kagi.com/search?q=pod&token=secret', true)
    links.hover('https://example.com/café', true)
    expect(sent.map((message) => 'url' in message && message.url)).toEqual([
      'https://kagi.com/search?q=pod',
      'https://example.com/caf%C3%A9'
    ])
  })

  it('shows no bubble for javascript:, mailto:, data: or an overlong link', () => {
    const { links, sent } = setup()
    for (const url of [
      'javascript:alert(1)',
      'mailto:someone@example.com',
      'data:text/html,<b>x</b>',
      `https://example.com/${'a'.repeat(9000)}`
    ]) {
      links.hover(url, true)
    }
    expect(sent).toEqual([])
  })

  it('shows nothing while an agent drives the page, and hides a shown URL when one starts', () => {
    const { links, sent } = setup()
    links.hover('https://example.com/a', false)
    expect(sent).toEqual([])
    links.hover('https://example.com/a', true)
    links.hover('https://example.com/b', false)
    expect(sent.at(-1)).toEqual({
      type: 'browserTargetUrl',
      pageId: 'page-1',
      url: ''
    })
  })

  it('forgets a shown URL on reset without telling PodNative', () => {
    const { links, sent } = setup()
    links.hover('https://example.com/a', true)
    links.reset()
    links.hover('https://example.com/a', true)
    expect(sent).toHaveLength(2)
  })
})

describe('PaneLinks open', () => {
  it.each([
    ['⌘-click', click('left', ['meta']), false, 'defaultBrowser'],
    ['middle-click', click('middle'), false, 'backgroundTab'],
    ['⌘-middle-click', click('middle', ['meta']), false, 'backgroundTab'],
    ['⌘⇧-click', click('left', ['meta', 'shift']), true, 'foregroundTab'],
    ['a plain click on target=_blank', click('left'), true, 'foregroundTab']
  ] as const)('%s opens the link in the %s', (_name, events, activate, target) => {
    const { links, sent } = setup()
    events.forEach((event) => links.noteInput(event))
    expect(links.open('https://example.com/a', activate)).toBe(true)
    expect(sent).toEqual([
      {
        type: 'browserOpenLink',
        pageId: 'page-1',
        url: 'https://example.com/a',
        target
      }
    ])
  })

  it('takes ⌘-Enter on a focused link as ⌘-click', () => {
    const { links, sent } = setup()
    links.noteInput({
      kind: 'key',
      action: 'down',
      keyCode: 'Enter',
      modifiers: ['meta']
    })
    links.open('https://example.com/a', false)
    expect(sent).toMatchObject([{ target: 'defaultBrowser' }])
  })

  it('spends a ⌘-click on one open, and after a second sends it to a tab behind', () => {
    const { links, sent, advance } = setup()
    click('left', ['meta']).forEach((event) => links.noteInput(event))
    links.open('https://example.com/a', false)
    expect(links.open('https://example.com/b', false)).toBe(false)
    click('left', ['meta']).forEach((event) => links.noteInput(event))
    advance(1_001)
    links.open('https://example.com/c', false)
    expect(sent.map((message) => 'target' in message && message.target)).toEqual([
      'defaultBrowser',
      'backgroundTab'
    ])
  })

  it('redacts the Kagi token only on the way to the default browser', () => {
    const { links, sent } = setup()
    const kagi = 'https://kagi.com/search?q=pod&token=secret'
    click('left', ['meta']).forEach((event) => links.noteInput(event))
    links.open(kagi, false)
    click('left').forEach((event) => links.noteInput(event))
    links.open(kagi, true)
    expect(sent.map((message) => 'url' in message && message.url)).toEqual([
      'https://kagi.com/search?q=pod',
      kagi
    ])
  })

  it('opens nothing that is not http(s), or too long for its line', () => {
    const { links, sent } = setup()
    for (const url of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      `https://example.com/${'a'.repeat(POD_UI_HOST_MAX_LINE_BYTES)}`
    ]) {
      click('left').forEach((event) => links.noteInput(event))
      expect(links.open(url, true)).toBe(false)
    }
    expect(sent).toEqual([])
  })
})

describe('PaneLinks gesture', () => {
  const key = (keyCode: string, modifiers: 'meta'[] = []): PodBrowserInputEvent => ({
    kind: 'key',
    action: 'down',
    keyCode,
    modifiers
  })

  it('refuses an open no click or key came before: no tab, nothing outside', () => {
    const { links, sent } = setup()
    expect(links.open('https://example.com/a', true)).toBe(false)
    expect(links.open('https://example.com/b', false)).toBe(false)
    expect(sent).toEqual([])
  })

  // The Edit menu sends ⌘C, ⌘V, ⌘A and ⌘Z as key downs; a page may open in its copy handler.
  it.each(['C', 'V', 'A', 'Z', 'B'])(
    'takes a ⌘%s key down as a plain key, never the default browser',
    (keyCode) => {
      const { links, sent } = setup()
      links.noteInput(key(keyCode, ['meta']))
      links.open('https://example.com/a', true)
      expect(sent).toMatchObject([{ target: 'foregroundTab' }])
    }
  )

  it("hands one ⌘-click's link to the default browser once, though its down and up both open", () => {
    const { links, sent } = setup()
    const [down, up] = click('left', ['meta'])
    links.noteInput(down)
    links.open('https://example.com/down', true)
    links.noteInput(up)
    expect(links.open('https://example.com/click', false)).toBe(false)
    expect(sent).toMatchObject([{ url: 'https://example.com/down', target: 'defaultBrowser' }])
  })

  it('lets a press held past a second still open on its up', () => {
    const { links, sent, advance } = setup()
    const [down, up] = click('left', ['meta'])
    links.noteInput(down)
    advance(6_000)
    links.noteInput(up)
    links.open('https://example.com/a', false)
    expect(sent).toMatchObject([{ target: 'defaultBrowser' }])
  })

  it('opens a tab within 5 s of a click, and none after', () => {
    const { links, sent, advance } = setup()
    click('left').forEach((event) => links.noteInput(event))
    advance(5_000)
    expect(links.open('https://example.com/a', true)).toBe(true)
    click('left').forEach((event) => links.noteInput(event))
    advance(5_001)
    expect(links.open('https://example.com/b', true)).toBe(false)
    expect(sent).toMatchObject([{ url: 'https://example.com/a', target: 'foregroundTab' }])
  })

  it("lets no agent command arm a gesture or ride the user's last click", () => {
    const { links, sent } = setup()
    links.noteAgentCommand()
    expect(links.open('https://example.com/a', true)).toBe(false)
    click('left', ['meta']).forEach((event) => links.noteInput(event))
    links.noteAgentCommand()
    expect(links.open('https://example.com/b', false)).toBe(false)
    expect(sent).toEqual([])
  })
})
