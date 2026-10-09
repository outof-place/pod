import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../../main/product-identity/product-identity'
import type { ProductIdentity } from '../../main/product-identity/product-identity'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../../main/product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { serveWithOrcad } from './serve-orcad-launch'

// Inline: the CLI project cannot compile main's test fixtures.
const POD: ProductIdentity = {
  displayName: 'Pod',
  appId: 'codes.pod.app',
  packageName: 'pod',
  cliName: 'podx',
  userDataName: 'Pod',
  keychainName: 'Pod',
  protocols: ['pod'],
  homepage: null,
  updateFeed: null,
  copyright: 'Copyright © 2026 outofplace',
  credits: 'Built on Orca',
  stablyServices: false,
  computerUseDisplayName: null,
  legacyProfile: null
}

const SELECTION = {
  kind: 'orcad',
  runtime: '/node',
  entry: '/slot/orcad.js',
  version: '1'
} as const

async function launchedEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  let launchEnv: NodeJS.ProcessEnv | undefined
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn()
  })
  const spawnChild = vi.fn(
    (_program: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      launchEnv = options.env
      return child
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recipe wait reads only stdout, kill, unref and events.
  const done = serveWithOrcad(SELECTION, { recipeJson: true }, '/profile', {}, spawnChild as never)
  child.emit('close', 1)
  await done.catch(() => undefined)
  return launchEnv
}

describe('podx serve on orcad', () => {
  afterEach(() => {
    identity.current = null
  })

  it('launches orcad like upstream Orca without an identity', async () => {
    expect(await launchedEnv()).not.toHaveProperty('POD_STABLY_SERVICES_OFF')
  })

  it('hands orcad the services-off flag it cannot read from the app bundle', async () => {
    identity.current = POD
    expect(await launchedEnv()).toMatchObject({ POD_STABLY_SERVICES_OFF: '1' })
  })
})
