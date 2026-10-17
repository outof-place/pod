import { RuntimeClientError } from '../../runtime-client'

export function resolveCompatibilityCliCommand(): 'orca' | 'orca-ide' | 'orca-dev' {
  const configured = process.env.POD_CLI_COMMAND
  if (configured === 'orca' || configured === 'orca-ide' || configured === 'orca-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'orca' | 'orca-ide' | undefined {
  if (process.env.POD_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.POD_CLI_COMMAND
  if (command === 'orca' || command === 'orca-ide') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.POD_USER_DATA_PATH?.includes('orca-dev') ?? false)
  )
}
