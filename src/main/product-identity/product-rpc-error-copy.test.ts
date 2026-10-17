import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from './product-identity'
import type { ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'
import {
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS
} from '../../shared/nested-worker-depth'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { brandRpcErrorCopy, MOVED_NEXT_STEP_SOURCES } from './product-rpc-error-copy'

const depthError = {
  code: NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  message: 'Sub-worker dispatch is not permitted at depth 2 (max 1). Complete this task yourself.',
  data: { effectsApplied: false, nextSteps: [...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS] }
}

describe('RPC error copy', () => {
  afterEach(() => {
    identity.current = null
  })

  it('leaves upstream Orca its own words', () => {
    expect(brandRpcErrorCopy(depthError)).toBe(depthError)
    expect(brandRpcErrorCopy({ code: 'x', message: 'Orca is not running' }).message).toBe(
      'Orca is not running'
    )
  })

  it('still finds the upstream next step it rewrites', () => {
    // Upstream reworded it: the rewrite no longer matches, so Pod would say upstream's place again.
    expect(MOVED_NEXT_STEP_SOURCES).toHaveLength(1)
  })

  it("points an agent at Pod's Orchestration settings when nesting is refused", () => {
    identity.current = podIdentityWithoutStablyServices()
    const branded = brandRpcErrorCopy(depthError)
    expect(branded.message).toBe(depthError.message)
    expect(branded.data).toEqual({
      effectsApplied: false,
      nextSteps: [
        'Do the work in this terminal instead of dispatching a sub-worker.',
        'To allow deeper nesting, open Settings › Agents › Orchestration in Pod and raise "Nested worker depth".'
      ]
    })
    expect(JSON.stringify(branded)).not.toContain('Orca')
    expect(depthError.data.nextSteps).toEqual([...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS])
  })

  it('brands the message and any other next step that names Orca', () => {
    identity.current = podIdentityWithoutStablyServices()
    const branded = brandRpcErrorCopy({
      code: 'runtime_unavailable',
      message: 'Orca is not running',
      data: { nextSteps: ['Open Orca, then try again.', 3], other: 'Orca' }
    })
    expect(branded).toEqual({
      code: 'runtime_unavailable',
      message: 'Pod is not running',
      data: { nextSteps: ['Open Pod, then try again.', 3], other: 'Orca' }
    })
  })

  it('leaves data without a next-steps list alone', () => {
    identity.current = podIdentityWithoutStablyServices()
    const data = { nextSteps: 'Open Orca' }
    expect(brandRpcErrorCopy({ code: 'x', message: 'm', data }).data).toBe(data)
  })
})
