import { describe, expect, it, vi } from 'vitest'
import type { AxTreeNode } from './agent-browser-snapshot-depth'
import { AgentBrowserSnapshotNarrowing } from './agent-browser-snapshot-narrowing'
import { axTree, wrapped, type AxSpec } from './ax-tree-test-harness'

const page = axTree({
  role: 'RootWebArea',
  children: [
    {
      role: 'none',
      ignored: true,
      children: [
        { role: 'banner', children: [{ role: 'link', name: 'Home' }] },
        { role: 'main', children: [wrapped(5, { role: 'button', name: 'Save' })] },
        // Deep prints at depth 3: contentinfo 0, list 1, listitem 2.
        {
          role: 'contentinfo',
          children: [
            {
              role: 'list',
              children: [{ role: 'listitem', children: [wrapped(6, { role: 'link', name: 'Deep' })] }]
            }
          ]
        }
      ]
    }
  ]
})

function chromium(tree: { cut: (depth?: number) => AxTreeNode[] }) {
  return vi.fn(async (params: Record<string, unknown>) => ({
    nodes: tree.cut(typeof params.depth === 'number' ? params.depth : -1)
  }))
}

function names(reply: unknown): string[] {
  const nodes: AxTreeNode[] =
    typeof reply === 'object' && reply !== null && 'nodes' in reply && Array.isArray(reply.nodes)
      ? reply.nodes
      : []
  return nodes.map((node) => String(node.name?.value ?? '')).filter(Boolean)
}

describe('AgentBrowserSnapshotNarrowing', () => {
  it('answers a depth snapshot with the shallowest cut that still holds what it prints', async () => {
    const narrowing = new AgentBrowserSnapshotNarrowing()
    const send = chromium(page)
    narrowing.expect({ depth: 1, interactive: false })

    const reply = await narrowing.fetch({}, 'https://a.test/', send)

    expect(names(reply)).toContain('Save')
    expect(names(reply)).not.toContain('Deep')
    expect(send.mock.calls.map(([params]) => params.depth)).toEqual([4, 5, 6, 7])
  })

  it('starts from the cut that answered last time on the same page', async () => {
    const narrowing = new AgentBrowserSnapshotNarrowing()
    narrowing.expect({ depth: 1, interactive: false })
    await narrowing.fetch({}, 'https://a.test/', chromium(page))
    const send = chromium(page)

    await narrowing.fetch({}, 'https://a.test/', send)

    expect(send.mock.calls.map(([params]) => params.depth)).toEqual([7])
  })

  it('takes the whole tree once a cut past the node limit still falls short, and next time at once', async () => {
    const wide: AxSpec = {
      role: 'RootWebArea',
      children: [
        { role: 'main', children: [wrapped(12, { role: 'button', name: 'Far' })] },
        {
          role: 'list',
          children: Array.from({ length: 5_000 }, (_, index) => ({
            role: 'listitem',
            children: [{ role: 'link', name: `item ${index}` }]
          }))
        }
      ]
    }
    const tree = axTree(wide)
    const narrowing = new AgentBrowserSnapshotNarrowing()
    narrowing.expect({ depth: 1, interactive: false })
    const send = chromium(tree)

    const reply = await narrowing.fetch({}, 'https://wide.test/', send)

    expect(names(reply)).toContain('Far')
    expect(send.mock.calls.at(-1)?.[0]).toEqual({})
    const again = chromium(tree)
    await narrowing.fetch({}, 'https://wide.test/', again)
    expect(again.mock.calls).toEqual([[{}]])
  })

  it('narrows only the snapshot it was told of: a ref lookup gets the whole tree', () => {
    const narrowing = new AgentBrowserSnapshotNarrowing()
    expect(narrowing.narrows({})).toBe(false)
    narrowing.expect({ depth: 2, interactive: false })
    expect(narrowing.narrows({})).toBe(true)
    expect(narrowing.narrows({ depth: 3 })).toBe(false)
    narrowing.expect(null)
    expect(narrowing.narrows({})).toBe(false)
  })
})
