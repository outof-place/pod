// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { COBROWSE_LIMITS } from '../../../shared/browser-cobrowse-types'
import { COBROWSE_READ_ELEMENT } from './pod-browser-cobrowse-read-element'

type Read = {
  tag: string
  selector: string
  text: string
  html: string
  frameUrl: string | null
  inShadowRoot: boolean
}

function read(element: Element): Read {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the declaration is the function CDP's callFunctionOn runs.
  const fn = new Function(`return (${COBROWSE_READ_ELEMENT})`)() as (
    this: Element,
    limits: unknown
  ) => Read
  return fn.call(element, COBROWSE_LIMITS)
}

describe('co-browse element read', () => {
  it('gives a selector that finds the same element again, among identical siblings', () => {
    document.body.innerHTML = `
      <main><ul class="list">
        <li class="row"><button class="btn">Edit</button></li>
        <li class="row"><button class="btn">Edit</button></li>
        <li class="row"><button class="btn">Edit</button></li>
      </ul></main>`
    const target = document.querySelectorAll('button')[1]
    const { selector } = read(target)
    expect(document.querySelectorAll(selector)).toHaveLength(1)
    expect(document.querySelector(selector)).toBe(target)
    // The page scrolling or growing elsewhere changes nothing the selector relies on.
    window.scrollTo(0, 500)
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<header><button class="btn">Top</button></header>'
    )
    expect(document.querySelector(selector)).toBe(target)
  })

  it('prefers a stable id and skips generated ones', () => {
    document.body.innerHTML = `<div id="a8f3c91be2"><span class="css-1x2y3z">x</span><button id="save">Save</button></div>`
    expect(read(document.getElementById('save')!).selector).toBe('button#save')
    const span = document.querySelector('span')!
    expect(read(span).selector).not.toContain('a8f3c91be2')
    expect(read(span).selector).not.toContain('css-1x2y3z')
    expect(document.querySelector(read(span).selector)).toBe(span)
  })

  it('reads text and a DOM excerpt without the scripts, and changes nothing', () => {
    document.body.innerHTML = `<section id="s"><p>Hello   <b>world</b></p><script>window.x = 1</script></section>`
    const before = document.body.innerHTML
    const { text, html, tag, frameUrl } = read(document.getElementById('s')!)
    expect(tag).toBe('section')
    expect(text).toContain('Hello world')
    expect(html).not.toContain('<script')
    expect(frameUrl).toBeNull()
    expect(document.body.innerHTML).toBe(before)
  })

  it('leaves script and style text out of the text, however long the script', () => {
    const long = `window.leak = "${'x'.repeat(5000)}"`
    document.body.innerHTML = `<section id="s"><p>Visible</p><script>${long}</script><style>.hidden-rule { color: red }</style><noscript>noscript-text</noscript><template><p>template-text</p></template><p>After</p></section>`
    const { text, html } = read(document.getElementById('s')!)
    expect(text).toBe('Visible After')
    for (const leaked of ['window.leak', 'xxxx', 'hidden-rule', 'noscript-text', 'template-text']) {
      expect(text).not.toContain(leaked)
      expect(html).not.toContain(leaked)
    }
    expect(html).toContain('<p>After</p>')
  })

  it('blanks password and hidden values and drops event handlers from the excerpt', () => {
    document.body.innerHTML = `<form id="f"><input type="password" name="pw" value="hunter2"><input type="hidden" name="state" value="tok-123"><input type="text" name="q" value="shoes"><button onclick="steal()" onmouseover="x()">Go</button></form>`
    const { html } = read(document.getElementById('f')!)
    expect(html).not.toContain('hunter2')
    expect(html).not.toContain('tok-123')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('steal')
    expect(html).not.toContain('onmouseover')
    expect(html).toContain('value="shoes"')
    expect(html).toContain('<button>Go</button>')
  })

  it('runs no custom element constructor while it reads', () => {
    let constructed = 0
    class Widget extends HTMLElement {
      constructor() {
        super()
        constructed += 1
      }
    }
    customElements.define('cobrowse-widget', Widget)
    document.body.innerHTML = `<div id="w"><cobrowse-widget>inner</cobrowse-widget></div>`
    const before = constructed
    const { html, text } = read(document.getElementById('w')!)
    expect(constructed).toBe(before)
    expect(html).toContain('<cobrowse-widget>inner</cobrowse-widget>')
    expect(text).toBe('inner')
  })

  it('says when the element sits in a shadow root', () => {
    document.body.innerHTML = `<div id="host"></div>`
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<button class="inner">In</button>`
    expect(read(shadow.querySelector('button')!).inShadowRoot).toBe(true)
    expect(read(document.getElementById('host')!).inShadowRoot).toBe(false)
  })
})
