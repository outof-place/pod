// Fork-only (Pod): the packaged CLI runs under ELECTRON_RUN_AS_NODE with the app's resourcesPath,
// so it reads the app's product identity; dev and upstream launches find none.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandProductName, type ProductNameBranding } from '../shared/product-name-branding'

let branding: ProductNameBranding | null | undefined

// Why not main's getProductIdentity: it is typed against Electron's process, which this build lacks.
function readCliBranding(): ProductNameBranding | null {
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  if (typeof resourcesPath !== 'string' || process.versions.electron === undefined) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(resourcesPath, 'product-identity.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const displayName = 'displayName' in value ? value.displayName : undefined
  const cliName = 'cliName' in value ? value.cliName : undefined
  return typeof displayName === 'string' && typeof cliName === 'string'
    ? { displayName, cliName }
    : null
}

export function brandCliHelp(text: string): string {
  if (branding === undefined) {
    branding = readCliBranding()
  }
  return branding ? brandProductName(text, branding) : text
}

export function _resetCliBrandingForTests(): void {
  branding = undefined
}
