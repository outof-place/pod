import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STAGED_STARTUP_COMMAND_STALE_MS,
  discardStagedStartupCommand,
  stageStartupCommand,
  startupLineRefusal,
  startupLineStagingReason,
  startupStagingFailureNotice,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-staging-test-'))
})

afterEach(() => {
  chmodSync(directory, 0o700)
  rmSync(directory, { recursive: true, force: true })
})

function stage(command: string, shellPath = '/bin/zsh', platform: NodeJS.Platform = 'darwin') {
  return stageStartupCommand({ command, shellPath, platform, directory })
}

describe('stageStartupCommand', () => {
  it('types a short single-line command as is', () => {
    expect(stage(`claude 'fix it'`)).toEqual({ command: `claude 'fix it'`, delivery: 'typed' })
    expect(readdirSync(directory)).toEqual([])
  })

  it('types exactly 512 bytes, stages 513', () => {
    expect(stage('a'.repeat(512)).delivery).toBe('typed')
    expect(stage('a'.repeat(513)).delivery).toBe('staged')
  })

  it('measures bytes, not characters', () => {
    expect(stage('é'.repeat(257)).delivery).toBe('staged')
  })

  it('ignores a trailing submit byte when measuring', () => {
    expect(stage(`${'a'.repeat(512)}\n`).delivery).toBe('typed')
    expect(stage(`${'a'.repeat(512)}\r\n`).delivery).toBe('typed')
  })

  it.each([['\n'], ['\r'], ['\t'], ['\x1b'], ['\x03'], ['\x7f']])(
    'stages a short line carrying control byte %j',
    (byte) => {
      expect(stage(`claude 'a${byte}b'`).delivery).toBe('staged')
    }
  )

  it('writes a 0600 script whose body is exactly the command, and types a sourcing line', () => {
    const command = `claude '${'x'.repeat(600)}'`
    const staged = stage(`${command}\n`)
    expect(staged.delivery).toBe('staged')
    expect(staged.scriptPath).toBeDefined()
    const scriptPath = staged.scriptPath!
    expect(staged.command).toBe(`. '${scriptPath}'`)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(scriptPath, 'utf8')).toBe(`command rm -f -- '${scriptPath}'\n${command}\n`)
  })

  it('evals the script in fish, which runs a sourced file without job control', () => {
    const staged = stage('a'.repeat(600), '/opt/homebrew/bin/fish')
    expect(staged.command).toBe(`eval (string collect < '${staged.scriptPath}')`)
  })

  it('recognizes a login shell name', () => {
    expect(stage('a'.repeat(600), '-zsh').delivery).toBe('staged')
  })

  // Why: ksh runs a sourced file's commands in the shell's own process group, so Ctrl-Z is lost.
  it.each([['/bin/ksh'], ['/usr/bin/mksh']])(
    'runs a long Orca-built line through /bin/sh in %s, and types a short one as is',
    (shellPath) => {
      const staged = stageStartupCommand({
        command: `claude '${'x'.repeat(600)}'`,
        shellPath,
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
      const command = `claude 'wow!! great'`
      expect(
        stageStartupCommand({
          command,
          shellPath,
          orcaBuiltLine: true,
          platform: 'darwin',
          directory
        })
      ).toEqual({ command, delivery: 'typed' })
    }
  )

  it.each([['/bin/ksh'], ['/usr/bin/mksh']])(
    'types a long command the user wrote as it always was in %s',
    (shellPath) => {
      const command = 'a'.repeat(600)
      expect(stage(command, shellPath)).toEqual({ command, delivery: 'typed' })
      expect(readdirSync(directory)).toEqual([])
    }
  )

  // Why: typed raw, tcsh runs a prompt's second line as a command and MAX_CANON cuts a long one.
  it.each([['/usr/bin/nu'], ['/bin/tcsh'], ['/usr/local/bin/pwsh'], [undefined]])(
    'runs an Orca-built launch line through /bin/sh for a shell that cannot source it (%s)',
    (shellPath) => {
      const staged = stageStartupCommand({
        command: `claude 'one\ntwo'`,
        shellPath,
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.delivery).toBe('staged')
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
    }
  )

  // Measured: tcsh typed `'fix C:'"\\"'dir'` as `fix C:\\dir` and expanded `!!` in `'wow!! great'`.
  it.each([['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'stages even a short Orca-built line for a shell that cannot source it (%s)',
    (shellPath) => {
      const command = `claude 'wow!! great'`
      const staged = stageStartupCommand({
        command,
        shellPath,
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
      expect(readFileSync(staged.scriptPath!, 'utf8')).toContain(`\n${command}\n`)
    }
  )

  // Why: behind `/bin/sh` the agent is not the shell's own job, and a pasted prompt waits on that.
  it.each([['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'types a short plain Orca-built line as is for a shell that cannot source it (%s)',
    (shellPath) => {
      const command = `claude '--dangerously-skip-permissions' '--model' 'claude-opus-5-5[1m]'`
      expect(
        stageStartupCommand({
          command,
          shellPath,
          orcaBuiltLine: true,
          platform: 'darwin',
          directory
        })
      ).toEqual({ command, delivery: 'typed' })
      expect(readdirSync(directory)).toEqual([])
    }
  )

  it.each([[`claude 'it'\\''s'`], ['claude "x"'], ["claude '$HOME'"], ["claude 'a`b'"]])(
    'stages a short Orca-built line tcsh would not read literally: %s',
    (command) => {
      const staged = stageStartupCommand({
        command,
        shellPath: '/bin/tcsh',
        orcaBuiltLine: true,
        platform: 'darwin',
        directory
      })
      expect(staged.command).toBe(`/bin/sh '${staged.scriptPath}'`)
    }
  )

  it('types a short Orca-built line in a shell that reads its quoting literally', () => {
    const command = `claude 'wow!! great'`
    expect(
      stageStartupCommand({ command, shellPath: '/bin/zsh', orcaBuiltLine: true, directory })
    ).toEqual({ command, delivery: 'typed' })
  })

  // Why: a quick command or --command written for tcsh or nu is not sh syntax.
  it.each([['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'types a command the user wrote as it always was in a shell that cannot source it (%s)',
    (shellPath) => {
      const command = `foreach f (*.log)\n  echo $f\nend`
      const staged = stageStartupCommand({ command, shellPath, platform: 'darwin', directory })
      expect(staged).toEqual({ command, delivery: 'typed' })
      expect(readdirSync(directory)).toEqual([])
    }
  )

  it('leaves Windows hosts alone', () => {
    expect(stage('a'.repeat(600), 'C:\\Program Files\\Git\\bin\\bash.exe', 'win32').delivery).toBe(
      'typed'
    )
    expect(stage('a'.repeat(600), '/bin/bash', 'win32').delivery).toBe('typed')
  })

  it('types the full command and says so when the script cannot be written', () => {
    const command = 'a'.repeat(600)
    const staged = stageStartupCommand({
      command,
      shellPath: '/bin/bash',
      platform: 'linux',
      directory: join(directory, 'missing')
    })
    expect(staged.command).toBe(command)
    expect(staged.delivery).toBe('typed-after-stage-failed')
    expect(staged.failure).toMatch(/ENOENT/)
    expect(staged.scriptPath).toBeUndefined()
  })

  it('gives every launch its own script', () => {
    const first = stage('a'.repeat(600))
    const second = stage('a'.repeat(600))
    expect(first.scriptPath).not.toBe(second.scriptPath)
  })
})

describe('discardStagedStartupCommand', () => {
  it('removes a script the shell never sourced', () => {
    const staged = stage('a'.repeat(600))
    discardStagedStartupCommand(staged)
    expect(readdirSync(directory)).toEqual([])
  })

  it('is a no-op once the script deleted itself', () => {
    const staged = stage('a'.repeat(600))
    rmSync(staged.scriptPath!)
    expect(() => discardStagedStartupCommand(staged)).not.toThrow()
  })
})

describe('sweepStaleStagedStartupCommands', () => {
  it('removes only staged scripts older than an hour', () => {
    const now = Date.now()
    const stale = join(directory, 'orca-launch-aaaa.sh')
    const fresh = join(directory, 'orca-launch-bbbb.sh')
    const unrelated = join(directory, 'something-else.sh')
    for (const path of [stale, fresh, unrelated]) {
      writeFileSync(path, '')
    }
    const staleSeconds = (now - STAGED_STARTUP_COMMAND_STALE_MS - 1000) / 1000
    utimesSync(stale, staleSeconds, staleSeconds)
    utimesSync(unrelated, staleSeconds, staleSeconds)
    sweepStaleStagedStartupCommands({ directory, now })
    expect(readdirSync(directory).sort()).toEqual(['orca-launch-bbbb.sh', 'something-else.sh'])
  })
})

describe('startupStagingFailureNotice', () => {
  it('says nothing when staging did not fail', () => {
    expect(startupStagingFailureNotice(stage(`claude 'fix it'`))).toBeNull()
    expect(startupStagingFailureNotice(stage(`claude '${'x'.repeat(600)}'`))).toBeNull()
  })

  it('prints one line naming the failure, with no control bytes from the reason', () => {
    const notice = startupStagingFailureNotice({
      command: 'x',
      delivery: 'typed-after-stage-failed',
      failure: 'EACCES: permission denied\nsecond line'
    })
    expect(notice).toBe(
      '\r\n[orca] Could not stage the launch command (EACCES: permission denied second line); typed it in full. If the shell shows quote> or waits for more input, press Ctrl-C and launch again.\r\n'
    )
  })
})

describe('startupLineStagingReason', () => {
  it.each([
    [`claude 'fix it'`, null],
    [`claude 'fix it'\n`, null],
    ['a'.repeat(512), null],
    ['a'.repeat(513), 'line-too-long'],
    [`claude 'one\ntwo'`, 'multi-line'],
    [`claude 'one\r\ntwo'`, 'multi-line'],
    [`claude 'a\x1bb'`, 'control-byte'],
    [`claude 'a\tb\nc'`, 'control-byte']
  ])('%j: %s', (command, reason) => {
    expect(startupLineStagingReason(command)).toBe(reason)
  })
})

// Pod: the local and daemon hosts pass `refuseUnstaged`; the relay does not.
describe('stageStartupCommand with refuseUnstaged', () => {
  function stageOrRefuse(command: string, shellPath: string | undefined, orcaBuiltLine = false) {
    return stageStartupCommand({
      command,
      shellPath,
      orcaBuiltLine,
      platform: 'darwin',
      directory,
      refuseUnstaged: true
    })
  }

  it.each([['/bin/ksh'], ['/usr/bin/mksh'], ['/bin/tcsh'], ['/usr/bin/nu'], [undefined]])(
    'refuses a user command that needs staging in a shell that cannot source it (%s)',
    (shellPath) => {
      expect(stageOrRefuse('a'.repeat(600), shellPath)).toEqual({
        command: '',
        delivery: 'refused',
        refusal: 'line-too-long'
      })
      expect(stageOrRefuse(`echo 'one\ntwo'`, shellPath)).toMatchObject({
        delivery: 'refused',
        refusal: 'multi-line'
      })
      expect(readdirSync(directory)).toEqual([])
    }
  )

  it('types a short user command as is in such a shell', () => {
    expect(stageOrRefuse(`echo 'fix it'`, '/bin/ksh')).toEqual({
      command: `echo 'fix it'`,
      delivery: 'typed'
    })
  })

  it('stages exactly as before where staging works', () => {
    const command = `claude 'one\n${'x'.repeat(600)}'`
    expect(stageOrRefuse(command, '/bin/zsh').command).toMatch(/^\. '.*orca-launch-[0-9a-f]+\.sh'$/)
    expect(stageOrRefuse(command, '/bin/ksh', true).command).toMatch(/^\/bin\/sh '/)
    expect(stageOrRefuse(command, '/bin/tcsh', true).command).toMatch(/^\/bin\/sh '/)
    for (const name of readdirSync(directory)) {
      expect(readFileSync(join(directory, name), 'utf8')).toContain(`\n${command}\n`)
    }
  })

  it('refuses, and types nothing, when the script cannot be written', () => {
    chmodSync(directory, 0o500)
    const staged = stageOrRefuse(`claude 'one\ntwo'`, '/bin/zsh', true)
    expect(staged).toMatchObject({ command: '', delivery: 'refused', refusal: 'multi-line' })
    expect(staged.failure).toMatch(/EACCES/)
    expect(staged.scriptPath).toBeUndefined()
  })

  it('still types a short Orca-built line staged only for tcsh quoting when the write fails', () => {
    chmodSync(directory, 0o500)
    const command = `claude 'wow!! great'`
    expect(stageOrRefuse(command, '/bin/tcsh', true)).toMatchObject({
      command,
      delivery: 'typed-after-stage-failed'
    })
  })

  it('leaves Windows hosts alone', () => {
    expect(
      stageStartupCommand({
        command: 'a'.repeat(600),
        shellPath: 'C:\\Windows\\System32\\cmd.exe',
        platform: 'win32',
        directory,
        refuseUnstaged: true
      }).delivery
    ).toBe('typed')
  })
})

describe('startupLineRefusal', () => {
  function refusal(command: string, shellPath: string | undefined, orcaBuiltLine = false) {
    return startupLineRefusal({ command, shellPath, orcaBuiltLine, platform: 'darwin', directory })
  }

  it('passes what the host types or stages, and leaves no file behind', () => {
    expect(refusal(`claude 'fix it'`, '/bin/ksh')).toBeNull()
    expect(refusal('a'.repeat(600), '/bin/zsh')).toBeNull()
    expect(refusal(`claude 'one\ntwo'`, '/opt/homebrew/bin/fish')).toBeNull()
    expect(refusal(`claude 'one\ntwo'`, '/bin/ksh', true)).toBeNull()
    expect(refusal(`claude 'one\ntwo'`, '/bin/tcsh', true)).toBeNull()
    expect(readdirSync(directory)).toEqual([])
  })

  it('names what the host would refuse', () => {
    expect(refusal('a'.repeat(600), '/bin/ksh')).toBe('line-too-long')
    expect(refusal(`echo 'one\ntwo'`, '/bin/tcsh')).toBe('multi-line')
    expect(refusal(`echo 'a\x1bb'`, undefined)).toBe('control-byte')
  })

  it('refuses when the script directory cannot be written', () => {
    chmodSync(directory, 0o500)
    expect(refusal(`claude 'one\ntwo'`, '/bin/zsh', true)).toBe('multi-line')
    expect(
      startupLineRefusal({
        command: 'a'.repeat(600),
        shellPath: '/bin/zsh',
        platform: 'darwin',
        directory: join(directory, 'missing')
      })
    ).toBe('line-too-long')
  })

  it('leaves Windows hosts alone', () => {
    expect(
      startupLineRefusal({
        command: 'a'.repeat(600),
        shellPath: '/bin/ksh',
        platform: 'win32',
        directory
      })
    ).toBeNull()
  })
})

describe('startupStagingFailureNotice for a refused line', () => {
  it('says the line was not typed, and why', () => {
    expect(
      startupStagingFailureNotice({ command: '', delivery: 'refused', refusal: 'multi-line' })
    ).toBe(
      '\r\n[orca] Did not type the launch command: it has more than one line, and this shell cannot run it staged. Paste it instead.\r\n'
    )
    expect(
      startupStagingFailureNotice({
        command: '',
        delivery: 'refused',
        refusal: 'line-too-long',
        failure: 'EACCES: permission denied\nsecond line'
      })
    ).toBe(
      '\r\n[orca] Did not type the launch command: it is over 512 bytes, and staging it failed (EACCES: permission denied second line). Paste it instead.\r\n'
    )
  })
})
