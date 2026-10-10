// node --test bench/lib/orca-instance.test.mjs
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PROFILE_BASE, cli } from './orca-instance.mjs'

test("the app CLI gets the profile under Orca's and Pod's names, and POD_ACC_LIFECYCLE=off", async () => {
  mkdirSync(PROFILE_BASE, { recursive: true })
  const ud = mkdtempSync(path.join(PROFILE_BASE, 'cli-test-'))
  try {
    // Stands in for orca/podx: echoes the environment it was given as the call's result.
    const fake = path.join(ud, 'fake-cli')
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '{"ok":true,"result":{"orca":"%s","pod":"%s","acc":"%s","home":"%s"}}' "$ORCA_USER_DATA_PATH" "$POD_USER_DATA_PATH" "$POD_ACC_LIFECYCLE" "$HOME"\n`
    )
    chmodSync(fake, 0o755)
    const home = path.join(ud, 'home')
    const instance = { info: { cli: fake }, profile: { ud, home } }
    assert.deepEqual(await cli(instance, ['status']), { orca: ud, pod: ud, acc: 'off', home })
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})
