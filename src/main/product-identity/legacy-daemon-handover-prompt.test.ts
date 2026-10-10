import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBox, background } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  background: { value: false }
}))
vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => background.value
}))

import {
  ADOPT_LEGACY_TERMINALS_ENV,
  offerLegacyDaemonHandover
} from './legacy-daemon-handover-prompt'
import { parseProductIdentity } from './product-identity'

const identity = parseProductIdentity(
  JSON.parse(readFileSync(join(__dirname, '../../../product/identity.json'), 'utf8'))
)

let root = ''
let orca = ''
let pod = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dhp-')))
  orca = join(root, 'orca')
  pod = join(root, 'pod')
  mkdirSync(join(orca, 'daemon'), { recursive: true })
  mkdirSync(pod)
  // A live v41 daemon (this process stands in for its pid); no real socket is needed to move it.
  for (const [extension, content] of [
    ['sock', ''],
    ['token', 'token'],
    ['pid', JSON.stringify({ pid: process.pid })]
  ]) {
    writeFileSync(join(orca, `daemon/daemon-v41.${extension}`), content)
  }
  writeFileSync(join(pod, 'product-profile-migration.json'), JSON.stringify({ from: orca }))
  background.value = false
  showMessageBox.mockClear()
  delete process.env[ADOPT_LEGACY_TERMINALS_ENV]
})

afterEach(() => {
  delete process.env[ADOPT_LEGACY_TERMINALS_ENV]
  rmSync(root, { recursive: true, force: true })
})

function handover(): unknown {
  const marker: unknown = JSON.parse(
    readFileSync(join(pod, 'product-profile-migration.json'), 'utf8')
  )
  return Reflect.get(Object(marker), 'daemonHandover')
}

describe('offerLegacyDaemonHandover', () => {
  it('keeps the daemons with Orca when the user does, and asks only once', async () => {
    await offerLegacyDaemonHandover(identity, pod)
    await offerLegacyDaemonHandover(identity, pod)

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(handover()).toMatchObject({ decision: 'kept' })
    expect(existsSync(join(orca, 'daemon/daemon-v41.sock'))).toBe(true)
    expect(existsSync(join(pod, 'daemon'))).toBe(false)
  })

  it('moves them on the explicit choice', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await offerLegacyDaemonHandover(identity, pod)

    expect(handover()).toMatchObject({ decision: 'moved', moved: [{ protocol: 41 }] })
    expect(existsSync(join(pod, 'daemon/daemon-v41.sock'))).toBe(true)
    expect(existsSync(join(orca, 'daemon/daemon-v41.sock'))).toBe(false)
  })

  it('never asks or records on a background launch, unless the env var opts in', async () => {
    background.value = true
    await offerLegacyDaemonHandover(identity, pod)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(handover()).toBeUndefined()

    process.env[ADOPT_LEGACY_TERMINALS_ENV] = '1'
    await offerLegacyDaemonHandover(identity, pod)
    expect(handover()).toMatchObject({ decision: 'moved', moved: [{ protocol: 41 }] })
  })

  it('waits while Orca runs', async () => {
    symlinkSync(`host.local-${process.pid}`, join(orca, 'SingletonLock'))
    process.env[ADOPT_LEGACY_TERMINALS_ENV] = '1'
    await offerLegacyDaemonHandover(identity, pod)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(handover()).toBeUndefined()
    expect(existsSync(join(orca, 'daemon/daemon-v41.sock'))).toBe(true)
  })
})
