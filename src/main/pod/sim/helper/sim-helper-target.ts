// Fork-only (Pod): where a tap on a `sim.*` target lands, from one `ax` snapshot. Pure: the RPC
// (stage 7) takes the snapshot with `all: true` and the target's text as `filter`, so off-screen
// matches are in it and can be named in the refusal. A tap lands on a node's centre (the middle of
// its on-screen part), never on its frame's origin, and only on a node the snapshot says is visible.
import type { z } from 'zod'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'
import type { SimNode } from '../../../../shared/pod-sim/sim-results'
import type { SimTarget } from '../../../../shared/rpc-contract/sim-params'
import type { SimHelperAxResult } from './sim-helper-protocol'

type Node = z.infer<typeof SimNode>
type Target = z.infer<typeof SimTarget>
type ElementRefusal = Extract<
  SimRefusalInput,
  { code: 'element_not_found' | 'element_ambiguous' | 'element_offscreen' }
>

export type SimTargetResolution =
  | {
      ok: true
      point: { x: number; y: number }
      resolved: { by: Target['by']; index?: number }
    }
  | { ok: false; refusal: ElementRefusal }

export function resolveSimTarget(
  snapshot: Pick<SimHelperAxResult, 'nodes' | 'screen'>,
  target: Target
): SimTargetResolution {
  if (target.by === 'point') {
    // The helper refuses a point off the screen itself.
    return { ok: true, point: { x: target.x, y: target.y }, resolved: { by: 'point' } }
  }
  const query =
    target.by === 'index'
      ? { by: 'index' as const, text: String(target.index) }
      : { by: target.by, text: target.text }
  const tiers =
    target.by === 'index'
      ? [snapshot.nodes.filter((node) => node.index === target.index)]
      : target.by === 'id'
        ? [snapshot.nodes.filter((node) => node.id === target.text)]
        : labelTiers(snapshot.nodes, target.text, target.exact === true)
  // The closest kind of match that has any candidate decides; looser ones are not consulted.
  const matches = tiers.find((tier) => tier.length > 0) ?? []
  const [first] = matches
  if (!first) {
    return { ok: false, refusal: { code: 'element_not_found', query } }
  }
  const tappable = matches.filter((node) => node.visible)
  const [node] = tappable
  if (!node) {
    return {
      ok: false,
      refusal: { code: 'element_offscreen', query, direction: scrollToward(first, snapshot.screen) }
    }
  }
  if (tappable.length > 1) {
    return {
      ok: false,
      refusal: { code: 'element_ambiguous', query, indexes: tappable.map((each) => each.index) }
    }
  }
  return { ok: true, point: node.centre, resolved: { by: target.by, index: node.index } }
}

/** Exact label first; then the same ignoring case and accents; then containing it. */
function labelTiers(nodes: readonly Node[], text: string, exact: boolean): Node[][] {
  const equal = nodes.filter((node) => node.label === text)
  if (exact) {
    return [equal]
  }
  const folded = fold(text)
  return [
    equal,
    nodes.filter((node) => node.label !== undefined && fold(node.label) === folded),
    nodes.filter((node) => node.label !== undefined && fold(node.label).includes(folded))
  ]
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
}

/** Which way to scroll to bring a node on screen; a covered node on screen goes by its half. */
function scrollToward(
  node: Node,
  screen: { width: number; height: number }
): 'up' | 'down' | 'left' | 'right' {
  const { x, y, width, height } = node.frame
  if (y >= screen.height) {
    return 'down'
  }
  if (y + height <= 0) {
    return 'up'
  }
  if (x >= screen.width) {
    return 'right'
  }
  if (x + width <= 0) {
    return 'left'
  }
  return node.centre.y > screen.height / 2 ? 'down' : 'up'
}
