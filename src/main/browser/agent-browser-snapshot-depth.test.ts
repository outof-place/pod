import { describe, expect, it } from 'vitest'
import { axTreeCoversSnapshotDepth } from './agent-browser-snapshot-depth'
import { axTree, wrapped } from './ax-tree-test-harness'

const SAVE = { role: 'button', name: 'Save' }

describe('axTreeCoversSnapshotDepth', () => {
  // main prints at 0; five lone generics print nothing, so Save prints at 1 although Chromium puts
  // it eight levels down.
  const page = axTree({
    role: 'RootWebArea',
    children: [{ role: 'main', children: [wrapped(5, SAVE)] }]
  })

  it('does not take a tree cut above a button that prints at depth 1', () => {
    expect(axTreeCoversSnapshotDepth(page.cut(6), { depth: 1, interactive: false })).toBe(false)
    expect(axTreeCoversSnapshotDepth(page.cut(7), { depth: 1, interactive: false })).toBe(true)
  })

  it('takes a cut once everything below it prints deeper than asked', () => {
    expect(axTreeCoversSnapshotDepth(page.cut(2), { depth: 0, interactive: false })).toBe(true)
  })

  it('counts a generic with two children as a printed level', () => {
    const twoChildren = axTree({
      role: 'RootWebArea',
      children: [{ role: 'generic', children: [{ role: 'link', name: 'a' }, wrapped(3, SAVE)] }]
    })
    expect(axTreeCoversSnapshotDepth(twoChildren.cut(3), { depth: 0, interactive: false })).toBe(
      true
    )
    expect(axTreeCoversSnapshotDepth(twoChildren.cut(3), { depth: 1, interactive: false })).toBe(
      false
    )
  })

  it('never fetches deeper for text cut off at the boundary: its only children are text boxes', () => {
    const text = axTree({
      role: 'RootWebArea',
      children: [
        {
          role: 'paragraph',
          children: [{ role: 'StaticText', name: 'Hi', children: [{ role: 'InlineTextBox' }] }]
        }
      ]
    })
    expect(axTreeCoversSnapshotDepth(text.cut(3), { depth: 1, interactive: false })).toBe(true)
  })

  it('in interactive mode, indents only at nodes with refs', () => {
    const nav = axTree({
      role: 'RootWebArea',
      children: [
        {
          role: 'navigation',
          name: 'Main',
          children: [{ role: 'list', children: [wrapped(2, SAVE)] }]
        }
      ]
    })
    // The list prints nothing in interactive mode, so Save sits at depth 1 under the navigation.
    expect(axTreeCoversSnapshotDepth(nav.cut(4), { depth: 1, interactive: true })).toBe(false)
    expect(axTreeCoversSnapshotDepth(nav.cut(5), { depth: 1, interactive: true })).toBe(true)
  })

  it('refuses a cut that prints an iframe: its frame refs come after every main-frame ref', () => {
    const framed = axTree({
      role: 'RootWebArea',
      children: [
        { role: 'Iframe', name: 'Checkout' },
        { role: 'main', children: [wrapped(5, SAVE)] }
      ]
    })
    expect(axTreeCoversSnapshotDepth(framed.cut(2), { depth: 0, interactive: false })).toBe(false)
    expect(axTreeCoversSnapshotDepth(framed.cut(), { depth: 0, interactive: false })).toBe(true)
  })

  it('refuses a tree where a node has two parents (aria-owns)', () => {
    const nodes = page.cut()
    const main = nodes.find((node) => node.role?.value === 'main')
    const save = nodes.find((node) => node.name?.value === 'Save')
    main?.childIds?.push(save?.nodeId ?? '')
    expect(axTreeCoversSnapshotDepth(nodes, { depth: 5, interactive: false })).toBe(false)
  })
})
