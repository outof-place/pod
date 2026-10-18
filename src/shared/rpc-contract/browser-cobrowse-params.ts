// Fork-only (Pod): co-browse's agent verbs (capability pod.browser.cobrowse.v1).
import { z } from 'zod'
import { COBROWSE_LIMITS } from '../browser-cobrowse-types'
import { BrowserTarget, OptionalBoolean, OptionalFiniteNumber } from './rpc-param-primitives'

export const BrowserMarks = BrowserTarget.extend({
  wait: OptionalBoolean,
  // ms, as browser.wait's.
  timeout: z.number().int().positive().max(COBROWSE_LIMITS.waitMaxMs).optional(),
  // The page's marks as they are, drafts included, none taken (PodNative's Copy as Markdown).
  peek: OptionalBoolean
})

export const BrowserPoint = BrowserTarget.extend({
  // A CSS selector, an agent-browser ref (@e3) or xpath=...
  element: z.string().min(1).max(COBROWSE_LIMITS.selector).optional(),
  x: OptionalFiniteNumber,
  y: OptionalFiniteNumber,
  width: OptionalFiniteNumber,
  height: OptionalFiniteNumber,
  label: z.string().max(COBROWSE_LIMITS.label).optional(),
  keep: OptionalBoolean,
  clear: OptionalBoolean,
  pointer: z.string().min(1).max(100).optional(),
  // One of the user's marks by its number (capability pod.browser.cobrowse.point-mark.v1).
  mark: z.number().int().positive().max(1_000_000).optional()
}).superRefine((params, ctx) => {
  const region = [params.x, params.y, params.width, params.height]
  const hasRegion = region.every((v) => v !== undefined)
  if (params.clear === true) {
    return
  }
  const targets = [params.element !== undefined, params.mark !== undefined, hasRegion]
  if (targets.filter(Boolean).length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Point at one of --mark <n>, --element <selector or @ref>, or a region with --x --y --width --height',
      path: ['element']
    })
  }
  if (hasRegion && ((params.width ?? 0) <= 0 || (params.height ?? 0) <= 0)) {
    ctx.addIssue({ code: 'custom', message: 'Width and height must be positive', path: ['width'] })
  }
})
