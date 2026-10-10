// Fork-only (Pod): the one-app control socket's peer check, native/pod-peer-identity-macos. The
// kernel's audit token for the connecting process, checked against a code requirement.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { PodBrowserFrames } from '../browser-pane/pod-browser-pane'

export const POD_PEER_IDENTITY_RESOURCE_PATH = join('native', 'pod-peer-identity.node')
export const POD_PEER_IDENTITY_BUILD_PATH = join(
  'native',
  'pod-peer-identity-macos',
  '.build',
  'release',
  'pod-peer-identity.node'
)

// PodNative signed by Pod's team: the shipped copy (Developer ID) or a development build.
export const POD_UI_PEER_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "75Y2KR6P5W" and ' +
  '(identifier "codes.pod.native" or identifier "codes.pod.native.dev")'

export type PodPeerCheck = { ok: boolean; pid: number; error?: string }
export type PodPeerVerifier = (socket: Socket) => PodPeerCheck

type PeerIdentityAddon = { checkPeer: (fd: number, requirement: string) => PodPeerCheck }

function isPeerIdentityAddon(value: unknown): value is PeerIdentityAddon {
  return (
    typeof value === 'object' &&
    value !== null &&
    'checkPeer' in value &&
    typeof value.checkPeer === 'function'
  )
}

function loadModule(path: string): unknown {
  try {
    const module = { exports: {} }
    process.dlopen(module, path)
    return module.exports
  } catch {
    return null
  }
}

function loadAddon(path: string): PeerIdentityAddon | null {
  const exports = loadModule(path)
  return isPeerIdentityAddon(exports) ? exports : null
}

function isBrowserFrames(value: unknown): value is PodBrowserFrames {
  return (
    typeof value === 'object' &&
    value !== null &&
    'browserConnect' in value &&
    typeof value.browserConnect === 'function' &&
    'browserDisconnect' in value &&
    typeof value.browserDisconnect === 'function' &&
    'browserSend' in value &&
    typeof value.browserSend === 'function'
  )
}

/** The browser pane's frame sender, which rides in the same addon; null when it is missing. */
export function loadPodBrowserFrames(addonPath: string): PodBrowserFrames | null {
  const exports = existsSync(addonPath) ? loadModule(addonPath) : null
  return isBrowserFrames(exports) ? exports : null
}

/** The descriptor under a connected net.Socket (libuv's pipe handle); null when there is none. */
export function socketDescriptor(socket: Socket): number | null {
  if (!('_handle' in socket)) {
    return null
  }
  const handle: unknown = socket._handle
  return typeof handle === 'object' &&
    handle !== null &&
    'fd' in handle &&
    typeof handle.fd === 'number' &&
    handle.fd >= 0
    ? handle.fd
    : null
}

/** The addon next to the packaged app's resources, or the checkout's build. */
export function podPeerIdentityAddonPath(options: {
  resourcesPath: string | null
  appPath: string
  isPackaged: boolean
}): string {
  return options.isPackaged && options.resourcesPath
    ? join(options.resourcesPath, POD_PEER_IDENTITY_RESOURCE_PATH)
    : join(options.appPath, POD_PEER_IDENTITY_BUILD_PATH)
}

/** A verifier for `requirement`, or null when the addon is missing (the socket then admits no one). */
export function loadPodPeerVerifier(
  addonPath: string,
  requirement: string = POD_UI_PEER_REQUIREMENT
): PodPeerVerifier | null {
  const addon = existsSync(addonPath) ? loadAddon(addonPath) : null
  if (!addon) {
    return null
  }
  return (socket) => {
    const fd = socketDescriptor(socket)
    return fd === null
      ? { ok: false, pid: 0, error: 'no socket descriptor' }
      : addon.checkPeer(fd, requirement)
  }
}
