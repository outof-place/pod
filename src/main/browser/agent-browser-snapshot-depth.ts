// Which part of Chromium's accessibility tree agent-browser 0.27's `snapshot --depth N` can print.
// Chromium walks getFullAXTree breadth first, so the tree cut at a depth is the head of the full list:
// the same nodes in the same order, hence the same refs. A cut tree prints the same lines as the full
// one once no node it cut below could still print at depth N; this decides that, after
// agent-browser's build_tree and render_tree (src/native/snapshot.rs).

export type AxTreeNode = {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  childIds?: string[]
  backendDOMNodeId?: number
}

export type SnapshotDepthOptions = { depth: number; interactive: boolean }

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
  'Iframe'
])
const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'article',
  'region',
  'main',
  'navigation'
])
const INVISIBLE_CHARACTERS = /\uFEFF|\u200B|\u200C|\u200D|\u2060|\u00A0/g

// agent-browser's extract_ax_string: strings, numbers and booleans as text, anything else empty.
function axText(value: { value?: unknown } | undefined): string {
  const raw = value?.value
  return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
    ? String(raw)
    : ''
}

type Shaped = { role: string; name: string; children: number[]; cut: boolean }

function shape(nodes: readonly AxTreeNode[]): Shaped[] {
  const indexById = new Map(nodes.map((node, index) => [node.nodeId, index]))
  const shaped = nodes.map((node): Shaped => {
    const role = axText(node.role)
    const kept = !((node.ignored === true && role !== 'RootWebArea') || role === 'InlineTextBox')
    const childIds = node.childIds ?? []
    const children = childIds.flatMap((id) => {
      const index = indexById.get(id)
      return index === undefined ? [] : [index]
    })
    return {
      role: kept ? role : '',
      name: kept ? axText(node.name) : '',
      children,
      // Why not text: its only children are InlineTextBoxes, which never print.
      cut: children.length < childIds.length && role !== 'StaticText'
    }
  })
  const clear = (index: number): void => {
    shaped[index] = { role: '', name: '', children: [], cut: false }
  }
  // Consecutive StaticText children merge into the first; a lone one naming its parent goes.
  for (const node of shaped) {
    if (node.role === '' || node.children.length === 0) {
      continue
    }
    const children = node.children
    let start = 0
    while (start < children.length) {
      if (shaped[children[start]].role !== 'StaticText') {
        start += 1
        continue
      }
      let end = start + 1
      while (end < children.length && shaped[children[end]].role === 'StaticText') {
        end += 1
      }
      if (end > start + 1) {
        shaped[children[start]].name = children
          .slice(start, end)
          .map((child) => shaped[child].name)
          .join('')
        children.slice(start + 1, end).forEach(clear)
      }
      start = end
    }
    if (
      children.length === 1 &&
      shaped[children[0]].role === 'StaticText' &&
      node.name === shaped[children[0]].name
    ) {
      clear(children[0])
    }
  }
  return shaped
}

// Whether render_tree surely prints the node and so indents its children one step deeper. A node
// agent-browser might give a ref only through its cursor scan (which runs in the page) is unsure,
// and unsure counts as not printed: the indent found is then a lower bound.
function surelyPrinted(node: Shaped, interactive: boolean): boolean {
  const ref =
    INTERACTIVE_ROLES.has(node.role) || (CONTENT_ROLES.has(node.role) && node.name !== '')
  if (node.role === '' || node.role === 'RootWebArea' || node.role === 'WebArea') {
    return false
  }
  if (node.role === 'generic' && !ref && node.children.length <= 1) {
    return false
  }
  if (node.role === 'StaticText' && node.name.replace(INVISIBLE_CHARACTERS, '') === '') {
    return false
  }
  return !interactive || ref
}

/** Whether a getFullAXTree reply cut at some depth prints what the full tree prints at `depth`. */
export function axTreeCoversSnapshotDepth(
  nodes: readonly AxTreeNode[],
  { depth, interactive }: SnapshotDepthOptions
): boolean {
  const shaped = shape(nodes)
  const parents = Array.from({ length: shaped.length }, () => -1)
  for (const [index, node] of shaped.entries()) {
    for (const child of node.children) {
      // Why: one indent per node needs one parent listed before it (an aria-owns child has two).
      if (parents[child] !== -1 || child < index) {
        return false
      }
      parents[child] = index
    }
  }
  // Parents come first in a breadth-first list, so one pass fills every indent.
  const indent = Array.from({ length: shaped.length }, () => 0)
  for (let index = 0; index < shaped.length; index++) {
    const parent = parents[index]
    if (parent !== -1) {
      indent[index] = indent[parent] + (surelyPrinted(shaped[parent], interactive) ? 1 : 0)
    }
    // A cut node at an indent the snapshot prints could print itself or its children.
    if (shaped[index].cut && indent[index] <= depth) {
      return false
    }
  }
  return true
}
