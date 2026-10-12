// Fork-only (Pod): the mcp-lazy shim this app ships (Contents/Resources/bin) and the copy wrapped
// MCP entries name, beside the managed hooks, so app moves and updates keep it.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getSharedManagedScriptPath } from '../../agent-hooks/installer-utils'

export const MCP_LAZY_FILE_NAME = 'mcp-lazy'

/** The shim this app ships, or POD_MCP_LAZY_BINARY's in a checkout; null off macOS. */
export function resolveBundledMcpLazy(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; resourcesPath?: string } = {}
): string | null {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null
  }
  const env = options.env ?? process.env
  const appResources: unknown = Reflect.get(process, 'resourcesPath')
  const resourcesPath =
    options.resourcesPath ?? (typeof appResources === 'string' ? appResources : undefined)
  const candidates = [
    env.POD_MCP_LAZY_BINARY,
    resourcesPath ? join(resourcesPath, 'bin', MCP_LAZY_FILE_NAME) : undefined
  ]
  return (
    candidates.find(
      (path): path is string => typeof path === 'string' && path !== '' && existsSync(path)
    ) ?? null
  )
}

export function getMcpLazyInstallPath(): string {
  return getSharedManagedScriptPath(MCP_LAZY_FILE_NAME)
}

/** Copies the shim when its bytes differ; temp + rename, since overwriting a binary in place gets
 *  its next launches SIGKILLed on macOS. */
export function installMcpLazyBinary(bundled: string, installPath: string): void {
  const content = readFileSync(bundled)
  if (existsSync(installPath) && readFileSync(installPath).equals(content)) {
    return
  }
  mkdirSync(dirname(installPath), { recursive: true })
  const temp = `${installPath}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o755 })
    chmodSync(temp, 0o755)
    renameSync(temp, installPath)
  } finally {
    rmSync(temp, { force: true })
  }
}
