import { z } from 'zod'
import { BrowserTarget, OptionalBoolean, OptionalFiniteNumber } from './rpc-param-primitives'

const VIEWPORT_SIZE_MESSAGE = 'Width and height must be positive numbers'
const ViewportLength = z.custom<number>((v) => typeof v === 'number' && v > 0, {
  message: VIEWPORT_SIZE_MESSAGE
})

export const Viewport = BrowserTarget.extend({
  width: ViewportLength.optional(),
  height: ViewportLength.optional(),
  deviceScaleFactor: OptionalFiniteNumber,
  mobile: OptionalBoolean,
  // Why optional: `viewport --reset` drops the emulated size; a runtime without it still asks for one.
  reset: OptionalBoolean
}).superRefine((params, ctx) => {
  if (params.reset !== true && (params.width === undefined || params.height === undefined)) {
    ctx.addIssue({ code: 'custom', message: VIEWPORT_SIZE_MESSAGE, path: ['width'] })
  }
})
