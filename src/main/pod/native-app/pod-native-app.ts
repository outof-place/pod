// Pod's native UI (PodNative) ships nested in the app; Pod opens it from the Window and Dock menus.
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import { getProductIdentity } from '../../product-identity/product-identity'

// Unpackaged runs (dev, E2E) point at a built copy; packaged ones use the nested app.
export const POD_NATIVE_APP_ENV = 'POD_NATIVE_APP'
// Why not translated: a product name, and a fork-only line in every locale catalog would conflict.
export const OPEN_POD_NATIVE_LABEL = 'Open PodNative'
// PodNative's LSMinimumSystemVersion is 27.0, which is Darwin 27.
const MIN_DARWIN_MAJOR = 27

export type PodNativeHost = {
  platform: NodeJS.Platform
  darwinRelease: string
  resourcesPath: string | undefined
  env: NodeJS.ProcessEnv
  hasProductIdentity: boolean
  exists: (path: string) => boolean
}

function currentHost(): PodNativeHost {
  const resourcesPath: unknown = Reflect.get(process, 'resourcesPath')
  return {
    platform: process.platform,
    darwinRelease: release(),
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined,
    env: process.env,
    hasProductIdentity: getProductIdentity() !== null,
    exists: existsSync
  }
}

/** The PodNative.app this build can open, or null (upstream builds, older macOS, no helper). */
export function resolvePodNativeApp(host: PodNativeHost = currentHost()): string | null {
  if (!host.hasProductIdentity || host.platform !== 'darwin') {
    return null
  }
  if (Number.parseInt(host.darwinRelease, 10) < MIN_DARWIN_MAJOR) {
    return null
  }
  // Apple's "Placing content in a bundle": helper apps go in Contents/Helpers.
  const appPath =
    host.env[POD_NATIVE_APP_ENV] ||
    (host.resourcesPath ? join(host.resourcesPath, '..', 'Helpers', 'PodNative.app') : null)
  return appPath && host.exists(join(appPath, 'Contents', 'Info.plist')) ? appPath : null
}

/** `open -a` brings a running PodNative forward; a new one gets this Pod's profile. */
export function podNativeOpenArgs(appPath: string, userDataPath: string): string[] {
  return ['-a', appPath, '--args', '--profile', userDataPath]
}

export async function openPodNative(appPath: string): Promise<void> {
  const result = await runProcess({
    program: '/usr/bin/open',
    args: podNativeOpenArgs(appPath, app.getPath('userData')),
    timeoutMs: 10_000
  })
  if (result.code !== 0) {
    console.warn(`[pod] open PodNative failed (${result.code}): ${result.stderr.trim()}`)
  }
}

function openItem(appPath: string): MenuItemConstructorOptions {
  return {
    label: OPEN_POD_NATIVE_LABEL,
    click: () => {
      void openPodNative(appPath).catch((error: unknown) => {
        console.warn('[pod] open PodNative failed:', error)
      })
    }
  }
}

/** Window menu items: empty when this build can't open PodNative. */
export function podNativeWindowMenuItems(
  host: PodNativeHost = currentHost()
): MenuItemConstructorOptions[] {
  const appPath = resolvePodNativeApp(host)
  return appPath ? [{ type: 'separator' }, openItem(appPath)] : []
}

/** The Dock icon's menu gets the same item; a no-op when this build can't open PodNative. */
export function installPodNativeDockMenu(host: PodNativeHost = currentHost()): void {
  const appPath = resolvePodNativeApp(host)
  if (appPath) {
    app.dock?.setMenu(Menu.buildFromTemplate([openItem(appPath)]))
  }
}
