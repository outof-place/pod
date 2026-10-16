// Fork-only (Pod): the desktop's remote folder browser (ssh:browseDir) for runtime RPC, installed by
// the IPC layer so the runtime's module graph stays free of Electron (config/runtime-electron-baseline.txt).
import type { FilesystemPathFlavor } from '../../../shared/filesystem-entry-types'

/** One folder level on an SSH host, as Add Remote Project lists it: folders first. */
export type SshRemoteDirListing = {
  entries: { name: string; isDirectory: boolean }[]
  /** The folder the host resolved (`~` expanded); `/`-separated on Windows hosts too. */
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
}

export type PodSshRemoteBrowse = (targetId: string, dirPath: string) => Promise<SshRemoteDirListing>

let installed: PodSshRemoteBrowse | null = null

export function setPodSshRemoteBrowse(browse: PodSshRemoteBrowse | null): void {
  installed = browse
}

/** Null on a host whose SSH layer never registered (orcad). */
export function getPodSshRemoteBrowse(): PodSshRemoteBrowse | null {
  return installed
}
