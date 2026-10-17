// Fork-only (Pod): an RPC error leaves the main process branded (errorResponse()), and so do the
// next steps it hands the agent or the CLI. Those name upstream's app, and a few say where upstream
// keeps a setting that Pod shows somewhere else.
import { NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS } from '../../shared/nested-worker-depth'
import { brandProductCopy, getProductNameBranding } from './product-overlay'

/** Upstream next steps that point at a place Pod moved, and what Pod says instead. */
const MOVED_NEXT_STEPS: ReadonlyMap<string, (product: string) => string> = new Map(
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS.filter((step) =>
    step.includes('Settings → Orchestration')
  ).map((step) => [
    step,
    (product: string) =>
      `To allow deeper nesting, open Settings › Agents › Orchestration in ${product} and raise "Nested worker depth".`
  ])
)

/** Upstream's next steps that this file rewrites; tests use it to catch upstream's copy drifting. */
export const MOVED_NEXT_STEP_SOURCES: readonly string[] = [...MOVED_NEXT_STEPS.keys()]

type RpcErrorCopy = { code: string; message: string; data?: unknown }

/** The error's message and its `data.nextSteps` as the product says them; upstream gets it as is. */
export function brandRpcErrorCopy(error: RpcErrorCopy): RpcErrorCopy {
  const branding = getProductNameBranding()
  if (!branding) {
    return error
  }
  const message = brandProductCopy(error.message)
  const { data } = error
  if (
    typeof data !== 'object' ||
    data === null ||
    !('nextSteps' in data) ||
    !Array.isArray(data.nextSteps)
  ) {
    return { ...error, message }
  }
  const nextSteps: unknown[] = data.nextSteps.map((step: unknown) =>
    typeof step === 'string'
      ? (MOVED_NEXT_STEPS.get(step)?.(branding.displayName) ?? brandProductCopy(step))
      : step
  )
  return { ...error, message, data: { ...data, nextSteps } }
}
