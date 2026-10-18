// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { COBROWSE_LIMITS } from '../../../shared/browser-cobrowse-types'
import { COBROWSE_READ_ELEMENT } from './pod-browser-cobrowse-cdp'

type Read = { tag: string; selector: string; text: string; html: string; frameUrl: string | null }

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
})
