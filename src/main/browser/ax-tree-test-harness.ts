import type { AxTreeNode } from './agent-browser-snapshot-depth'

export type AxSpec = { role: string; name?: string; ignored?: boolean; children?: AxSpec[] }

type Built = { node: AxTreeNode; spec: AxSpec; children: Built[] }

/** An accessibility tree as Chromium 156 lists it, whole or cut at a depth (WalkAXNodesToDepth). */
export function axTree(root: AxSpec): { cut: (depth?: number) => AxTreeNode[] } {
  let nextId = 1
  const build = (spec: AxSpec, parentId?: string): Built => {
    const nodeId = String(nextId++)
    const node: AxTreeNode & { parentId?: string } = {
      nodeId,
      ignored: spec.ignored === true,
      role: { value: spec.role },
      name: { value: spec.name ?? '' },
      backendDOMNodeId: Number(nodeId) + 1000,
      ...(parentId ? { parentId } : {})
    }
    const children = (spec.children ?? []).map((child) => build(child, nodeId))
    node.childIds = children.map((child) => child.node.nodeId)
    return { node, spec, children }
  }
  const built = build(root)
  // Children included in the list: ignored ones are followed down to the next unignored layer.
  const addChildren = (parent: Built, list: AxTreeNode[]): void => {
    for (const child of parent.children) {
      list.push(child.node)
      if (child.spec.ignored) {
        addChildren(child, list)
      }
    }
  }
  const unignoredChildren = (parent: Built): Built[] =>
    parent.children.flatMap((child) => (child.spec.ignored ? unignoredChildren(child) : [child]))
  return {
    cut: (depth = -1) => {
      const list = [built.node]
      const queue: [Built, number][] = [[built, 1]]
      for (let index = 0; index < queue.length; index++) {
        const [current, level] = queue[index]
        addChildren(current, list)
        if (depth === -1 || level < depth) {
          unignoredChildren(current).forEach((child) => queue.push([child, level + 1]))
        }
      }
      return list
    }
  }
}

/** `count` generic wrappers, each with one child, around `inner`. */
export function wrapped(count: number, inner: AxSpec): AxSpec {
  return count === 0 ? inner : { role: 'generic', children: [wrapped(count - 1, inner)] }
}
