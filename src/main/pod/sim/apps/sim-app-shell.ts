// Fork-only (Pod): how the app module runs a recipe's commands. A recipe command is shell text
// (`./node_modules/.bin/fingerprint fingerprint:generate --platform ios`), run by /bin/sh in the
// app's folder with the runtime's environment (its PATH comes from the login shell at startup) plus
// the recipe's `env`. Short commands run to completion here; Metro and builds outlive the call and
// start detached (sim-app-spawn.ts).
import { runProcess } from '@orca/process-host'
import { stripInheritedBuildModeEnv } from '../../../pty/build-mode-env'
import type { SimRunResult } from '../adapters/sim-command-run'

export type SimShellOptions = Readonly<{
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}>

export type SimShell = (command: string, options: SimShellOptions) => Promise<SimRunResult>

export const simShell: SimShell = async (command, options) => {
  try {
    const result = await runProcess(
      {
        program: '/bin/sh',
        args: ['-c', command],
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024
      },
      'tail'
    )
    if (result.timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        message: `${command} ran past ${options.timeoutMs} ms`
      }
    }
    if (result.code === null) {
      return {
        ok: false,
        reason: 'signal',
        message: `${command} was killed by ${result.signal ?? 'a signal'}`
      }
    }
    return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { ok: false, reason: 'spawn', message: `${command}: ${String(error)}` }
  }
}

/** The environment a recipe command of `app` runs with. */
export function simAppEnv(
  env: Readonly<Record<string, string>> | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  // The runtime's NODE_ENV is its own build mode, as for terminals (build-mode-env.ts).
  const inherited = stripInheritedBuildModeEnv(base)
  // A build's `pod install` (CocoaPods) fails without a UTF-8 locale; Pod started from Finder has none.
  inherited.LANG ??= 'en_US.UTF-8'
  return { ...inherited, ...env }
}
