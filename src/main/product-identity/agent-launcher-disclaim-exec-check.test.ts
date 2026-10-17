import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/agent-launcher/install-agent-launcher.cjs')
const assertDisclaimExecHonored: unknown = Reflect.get(
  Object(installer),
  'assertDisclaimExecHonored'
)

let root = ''

// A launcher stand-in: the build check only looks at its exit status and stderr.
function fakeLauncher(name: string, body: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function check(launcher: string): void {
  if (typeof assertDisclaimExecHonored !== 'function') {
    throw new Error('install-agent-launcher.cjs exports no assertDisclaimExecHonored')
  }
  assertDisclaimExecHonored(launcher)
}

// The check passing for the real launcher is covered by agent-launcher.test.ts, whose install runs it.
describe.skipIf(process.platform !== 'darwin')('the build-time check of --disclaim-exec', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'disclaim-check-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('passes for a launcher that execs the program', () => {
    expect(() => check(fakeLauncher('execs', 'exit 0'))).not.toThrow()
  })

  it('fails the build when the launcher falls back without disclaiming', () => {
    const launcher = fakeLauncher(
      'falls-back',
      'echo "pod-agent-launcher: /usr/bin/true starts without its own responsibility (x)" >&2'
    )
    expect(() => check(launcher)).toThrow(/did not take/)
  })

  it('fails the build when the launcher exits non-zero', () => {
    expect(() => check(fakeLauncher('exits-64', 'exit 64'))).toThrow(/exit 64/)
  })
})
