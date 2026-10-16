import { describe, expect, it } from 'vitest'
import { resolveSimTarget } from './sim-helper-target'
import type { SimHelperAxResult } from './sim-helper-protocol'

type Node = SimHelperAxResult['nodes'][number]

// Rows from stage 0's agenda screen (iPhone 17, 402 x 874 points); centres worked out by hand.
const screen = { width: 402, height: 874, scale: 3 }
const node = (index: number, fields: Partial<Node> & Pick<Node, 'frame' | 'centre'>): Node => ({
  index,
  role: 'AXButton',
  visible: true,
  ...fields
})
const start = node(4, {
  label: 'Start',
  frame: { x: 20, y: 799, width: 66, height: 36 },
  centre: { x: 53, y: 817 }
})
const search = node(7, {
  role: 'AXTextField',
  label: 'Search bookings',
  id: 'agenda-search',
  frame: { x: 16, y: 64, width: 370, height: 36 },
  centre: { x: 201, y: 82 }
})
const seeMore = node(16, {
  label: 'See more',
  frame: { x: 16, y: 852, width: 370, height: 44 },
  // The middle of the part above the screen's bottom edge.
  centre: { x: 201, y: 863 }
})
const more = node(30, {
  label: 'More',
  role: 'AXTab',
  frame: { x: 321, y: 791, width: 81, height: 49 },
  centre: { x: 361.5, y: 815.5 }
})
const bartek = node(21, {
  label: 'Bartek Zawada',
  role: 'AXStaticText',
  visible: false,
  frame: { x: 425.67, y: 300, width: 200, height: 20 },
  centre: { x: 525.67, y: 310 }
})
const belowFold = node(40, {
  label: 'Cancel booking',
  visible: false,
  frame: { x: 16, y: 1210, width: 370, height: 44 },
  centre: { x: 201, y: 1232 }
})
const covered = node(12, {
  label: 'Mangusta 80',
  visible: false,
  frame: { x: 16, y: 600, width: 370, height: 60 },
  centre: { x: 201, y: 630 }
})
const zazolc = node(9, {
  role: 'AXStaticText',
  label: 'Zażółć Gęślą Jaźń',
  frame: { x: 16, y: 400, width: 370, height: 20 },
  centre: { x: 201, y: 410 }
})
const snapshot = {
  screen,
  nodes: [start, search, zazolc, covered, seeMore, bartek, more, belowFold]
}

describe('where a tap on a sim target lands', () => {
  it('lands on the middle of the element, not on its frame origin', () => {
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'Start' })).toEqual({
      ok: true,
      point: { x: 53, y: 817 },
      resolved: { by: 'label', index: 4 }
    })
    expect(resolveSimTarget(snapshot, { by: 'id', text: 'agenda-search' })).toMatchObject({
      ok: true,
      point: { x: 201, y: 82 }
    })
    expect(resolveSimTarget(snapshot, { by: 'index', index: 16 })).toMatchObject({
      ok: true,
      point: { x: 201, y: 863 }
    })
  })

  it('never taps an element the snapshot marks not visible, and says which way to scroll', () => {
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'Cancel booking' })).toEqual({
      ok: false,
      refusal: {
        code: 'element_offscreen',
        query: { by: 'label', text: 'Cancel booking' },
        direction: 'down'
      }
    })
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'Bartek' })).toMatchObject({
      ok: false,
      refusal: { code: 'element_offscreen', direction: 'right' }
    })
    // Covered by a sheet but inside the screen: still refused, never tapped through the sheet.
    expect(resolveSimTarget(snapshot, { by: 'index', index: 12 })).toMatchObject({
      ok: false,
      refusal: { code: 'element_offscreen', query: { by: 'index', text: '12' } }
    })
  })

  it('prefers the visible one when the same label is also off screen', () => {
    const twin = { ...belowFold, index: 41, label: 'Start' }
    expect(
      resolveSimTarget({ screen, nodes: [twin, start] }, { by: 'label', text: 'Start' })
    ).toMatchObject({ ok: true, point: { x: 53, y: 817 } })
  })

  it('names every visible candidate instead of guessing between them', () => {
    const second = {
      ...start,
      index: 5,
      frame: { ...start.frame, x: 120 },
      centre: { x: 153, y: 817 }
    }
    expect(
      resolveSimTarget({ screen, nodes: [start, second] }, { by: 'label', text: 'Start' })
    ).toEqual({
      ok: false,
      refusal: {
        code: 'element_ambiguous',
        query: { by: 'label', text: 'Start' },
        indexes: [4, 5]
      }
    })
  })

  it('takes the closest kind of label match: equal before folded before contained', () => {
    // "More" is also inside "See more"; the equal label wins without an ambiguity.
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'More' })).toMatchObject({
      ok: true,
      resolved: { index: 30 }
    })
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'more' })).toMatchObject({
      ok: true,
      resolved: { index: 30 }
    })
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'gesla' })).toMatchObject({
      ok: true,
      resolved: { index: 9 }
    })
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'search' })).toMatchObject({
      ok: true,
      resolved: { index: 7 }
    })
  })

  it('with exact, matches the label as written and nothing looser', () => {
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'more', exact: true })).toEqual({
      ok: false,
      refusal: { code: 'element_not_found', query: { by: 'label', text: 'more' } }
    })
    expect(resolveSimTarget(snapshot, { by: 'label', text: 'More', exact: true })).toMatchObject({
      ok: true,
      resolved: { index: 30 }
    })
  })

  it('refuses what the snapshot does not have, by the query the caller sent', () => {
    expect(resolveSimTarget(snapshot, { by: 'id', text: 'agenda' })).toEqual({
      ok: false,
      refusal: { code: 'element_not_found', query: { by: 'id', text: 'agenda' } }
    })
    expect(resolveSimTarget(snapshot, { by: 'index', index: 99 })).toEqual({
      ok: false,
      refusal: { code: 'element_not_found', query: { by: 'index', text: '99' } }
    })
  })

  it('passes a point through for the helper to check', () => {
    expect(resolveSimTarget(snapshot, { by: 'point', x: 10, y: 20 })).toEqual({
      ok: true,
      point: { x: 10, y: 20 },
      resolved: { by: 'point' }
    })
  })
})
