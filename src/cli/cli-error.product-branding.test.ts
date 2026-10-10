import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../main/product-identity/product-identity'
import {
  parseProductIdentity,
  type ProductIdentity
} from '../main/product-identity/product-identity'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../main/product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { reportCliError } from './cli-error'
import { RuntimeClientError } from './runtime/types'

// Why the shipped file: the CLI project cannot compile main's test fixtures.
const POD = parseProductIdentity(
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'product', 'identity.json'), 'utf8'))
)

afterEach(() => {
  identity.current = null
  vi.restoreAllMocks()
})

function reported(json: boolean): string {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  reportCliError(new RuntimeClientError('runtime_unavailable', 'Orca is not reachable.'), json)
  return [...error.mock.calls, ...log.mock.calls].map((call) => String(call[0])).join('\n')
}

describe('CLI errors in a product build', () => {
  it('print upstream copy without an identity', () => {
    expect(reported(false)).toBe(
      "Orca is not reachable.\nOrca is not running. Run 'orca open' first."
    )
  })

  it('name the product and its command in human output', () => {
    identity.current = POD
    expect(reported(false)).toBe(
      "Pod is not reachable.\nPod is not running. Run 'podx open' first."
    )
  })

  it('leave the JSON contract as the runtime sent it', () => {
    identity.current = POD
    expect(JSON.parse(reported(true)).error.message).toBe('Orca is not reachable.')
  })
})
