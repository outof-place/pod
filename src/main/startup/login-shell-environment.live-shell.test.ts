/**
 * The zsh arm of `login-shell-environment.test.ts`: the probe's own argv in a real zsh. Runs in the
 * real-shell lane, which installs zsh; the ordinary unit lane has none.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shellProbe } from './login-shell-environment'

let testHome: string | null = null

afterEach(async () => {
  if (testHome) {
    await rm(testHome, { recursive: true, force: true })
    testHome = null
  }
})

describe.runIf(existsSync('/bin/zsh'))('the login-shell env probe in a real zsh', () => {
  // Pod: a reader that goes away after the shell's startup output (a runtime quitting at
  // startup) used to leave both zsh processes hung for good when a zshexit hook forks, as
  // Terminal.app's session save does: SIGPIPE inside printf's flush, exit from the signal
  // handler, a child deadlocked on the inherited stdout lock.
  it('leaves no shell behind when the reader goes away mid-probe', async () => {
    testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
    await writeFile(
      join(testHome, '.zshrc'),
      ['zshexit() { ( echo saved >| "$ZDOTDIR/session" ) }', 'print ready', 'sleep 0.3'].join('\n')
    )
    const args = shellProbe('/bin/zsh')
    expect(args).not.toBeNull()
    const child = spawn('/bin/zsh', args ?? [], {
      env: { PATH: '/usr/bin:/bin', HOME: testHome, ZDOTDIR: testHome },
      stdio: ['pipe', 'pipe', 'ignore'],
      // Its own group: a hung run's subshell goes too.
      detached: true
    })
    child.stdin.end()
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.stdout.destroy()
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited && child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
    expect(exited).toBe(true)
  }, 10_000)
})
