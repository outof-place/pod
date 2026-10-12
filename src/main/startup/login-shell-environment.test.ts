import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment,
  shellProbe
} from './login-shell-environment'

const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const SHELL_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_SHELL_ONLY'
const originalShellOnlyValue = process.env[SHELL_ONLY_VARIABLE]
let testHome: string | null = null

// Why: this case spawns a REAL login shell, so it can only run against one the
// machine actually has. Hardcoding /bin/zsh made it fail on Linux CI, where zsh
// is not installed — the resolver simply returned the parent env and the
// assertion read `undefined`. Each entry pairs a shell with the profile file an
// interactive login shell of that family sources (bash reads .bash_profile when
// it is a login shell, never .bashrc).
const REAL_SHELL_CANDIDATES = [
  { path: '/bin/zsh', profileFile: '.zshenv' },
  { path: '/bin/bash', profileFile: '.bash_profile' }
] as const

const realShell = REAL_SHELL_CANDIDATES.find((candidate) => existsSync(candidate.path)) ?? null

afterEach(async () => {
  resetLoginShellEnvironmentCacheForTests()
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalZdotdir === undefined) {
    delete process.env.ZDOTDIR
  } else {
    process.env.ZDOTDIR = originalZdotdir
  }
  if (originalShellOnlyValue === undefined) {
    delete process.env[SHELL_ONLY_VARIABLE]
  } else {
    process.env[SHELL_ONLY_VARIABLE] = originalShellOnlyValue
  }
  if (testHome) {
    await rm(testHome, { recursive: true, force: true })
    testHome = null
  }
})

describe('resolveLoginShellEnvironment', () => {
  it('returns variables exported by the profile-loading shell', async () => {
    const spawner = vi.fn(async () => ({
      ...process.env,
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported'
    }))

    await expect(
      resolveLoginShellEnvironment({ shellOverride: '/bin/zsh', spawner })
    ).resolves.toMatchObject({ EXAMPLE_GATEWAY_TOKEN: 'shell-exported' })
  })

  it.runIf(realShell !== null)(
    'captures a profile export missing from the parent process',
    async () => {
      const shell = realShell!
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
      await writeFile(
        join(testHome, shell.profileFile),
        `export ${SHELL_ONLY_VARIABLE}=shell-only\n`
      )
      process.env.HOME = testHome
      // zsh reads .zshenv from ZDOTDIR when set; harmless for the bash variant.
      process.env.ZDOTDIR = testHome
      delete process.env[SHELL_ONLY_VARIABLE]

      const environment = await resolveLoginShellEnvironment({
        shellOverride: shell.path,
        force: true
      })
      expect(environment[SHELL_ONLY_VARIABLE]).toBe('shell-only')
    }
  )

  // Pod: a reader that goes away after the shell's startup output (a runtime quitting at
  // startup) used to leave both zsh processes hung for good when a zshexit hook forks, as
  // Terminal.app's session save does: SIGPIPE inside printf's flush, exit from the signal
  // handler, a child deadlocked on the inherited stdout lock.
  it.runIf(existsSync('/bin/zsh'))(
    'leaves no shell behind when the reader goes away mid-probe',
    async () => {
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
      await writeFile(
        join(testHome, '.zshrc'),
        ['zshexit() { ( echo saved >| "$ZDOTDIR/session" ) }', 'print ready', 'sleep 0.3'].join(
          '\n'
        )
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
    },
    10_000
  )
})
