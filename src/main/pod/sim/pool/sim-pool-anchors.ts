// Fork-only (Pod): the monotonic anchors behind every window, in two layers so a step copies only
// what it changes: a base no step edits, shared from step to step, and a small layer of changes on
// top (null removes a base anchor). A layer grown past SIM_ANCHOR_LAYER_MAX folds into a new base.

export type SimWindowAnchor = Readonly<{ value: string | number; mono: number }>

export type SimWindowAnchors = Readonly<{
  base: ReadonlyMap<string, SimWindowAnchor>
  layer: ReadonlyMap<string, SimWindowAnchor | null>
}>

export type SimAnchorDraft = {
  readonly base: ReadonlyMap<string, SimWindowAnchor>
  readonly layer: Map<string, SimWindowAnchor | null>
}

/** A call touches two anchors: a fold (one copy of the base) every eight calls or so. */
export const SIM_ANCHOR_LAYER_MAX = 16

export function noAnchors(): SimWindowAnchors {
  return { base: new Map(), layer: new Map() }
}

export function draftAnchors(anchors: SimWindowAnchors): SimAnchorDraft {
  return { base: anchors.base, layer: new Map(anchors.layer) }
}

export function getAnchor(anchors: SimAnchorDraft, key: string): SimWindowAnchor | undefined {
  const changed = anchors.layer.get(key)
  return changed === undefined ? anchors.base.get(key) : (changed ?? undefined)
}

export function setAnchor(anchors: SimAnchorDraft, key: string, anchor: SimWindowAnchor): void {
  anchors.layer.set(key, anchor)
}

export function dropAnchor(anchors: SimAnchorDraft, key: string): void {
  if (anchors.base.has(key)) {
    anchors.layer.set(key, null)
  } else {
    anchors.layer.delete(key)
  }
}

/** Visits every anchor once; `visit` may set or drop the key it is given. */
export function forEachAnchor(
  anchors: SimAnchorDraft,
  visit: (key: string, anchor: SimWindowAnchor) => void
): void {
  const layer = [...anchors.layer]
  for (const [key, anchor] of anchors.base) {
    if (!anchors.layer.has(key)) {
      visit(key, anchor)
    }
  }
  for (const [key, anchor] of layer) {
    if (anchor) {
      visit(key, anchor)
    }
  }
}

/** One base holding every anchor whose key `keep` accepts, under an empty layer. */
export function foldAnchors(
  anchors: SimAnchorDraft,
  keep: (key: string) => boolean
): SimAnchorDraft {
  const base = new Map<string, SimWindowAnchor>()
  forEachAnchor(anchors, (key, anchor) => {
    if (keep(key)) {
      base.set(key, anchor)
    }
  })
  return { base, layer: new Map() }
}
