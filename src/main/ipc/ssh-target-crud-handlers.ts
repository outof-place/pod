import { ipcMain } from 'electron'
import type {
  SshConfigHostListArgs,
  SshRepoReadoption,
  SshTarget,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../shared/ssh-types'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../ssh/ssh-config-host-picker'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { closeOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import {
  allowsDirectSshRelay,
  isManagedOrcadSshTarget,
  isRuntimeOwnedSshTarget
} from '../ssh/ssh-connection-store'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { fingerprintRuntimeSshTarget } from '../ssh/runtime-ssh-access'
import { removeRegisteredSshTarget } from './ssh-session-teardown'

// Why: add/import can re-adopt workspaces orphaned on a removed target id (see ssh-target-readoption); the renderer must refresh its repo list to surface them.
function takeRepoReadoptions(): SshRepoReadoption[] {
  const store = getSshTargetRegistryStore()
  if (!store || store.lastRepoReadoptions.length === 0) {
    return []
  }
  const repoReadoptions = store.lastRepoReadoptions
  store.lastRepoReadoptions = []
  for (const targetId of new Set(
    repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
  )) {
    rotateSshProviderAuthority(targetId)
  }
  const win = getCurrentMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('repos:changed')
  }
  return repoReadoptions
}

// Why: generations, provisioning, the server fence and the runtime ladder cache are main-owned;
// a renderer must not forge them.
function omitRendererSshTargetGeneration<
  T extends {
    generation?: unknown
    orcadProvisioning?: unknown
    orcadFence?: unknown
    managedServerUnavailable?: unknown
    managedServerMoveOffered?: unknown
    managedServerUpdateFailure?: unknown
    remoteRuntimeResolution?: unknown
  }
>(
  value: T
): Omit<
  T,
  | 'generation'
  | 'orcadProvisioning'
  | 'orcadFence'
  | 'managedServerUnavailable'
  | 'managedServerMoveOffered'
  | 'managedServerUpdateFailure'
  | 'remoteRuntimeResolution'
> {
  const {
    generation: _generation,
    orcadProvisioning: _orcadProvisioning,
    orcadFence: _orcadFence,
    managedServerUnavailable: _managedServerUnavailable,
    managedServerMoveOffered: _managedServerMoveOffered,
    managedServerUpdateFailure: _managedServerUpdateFailure,
    remoteRuntimeResolution: _remoteRuntimeResolution,
    ...rest
  } = value
  return rest
}

function assertNotRuntimeOwned(targetId: string, action: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isRuntimeOwnedSshTarget(target)) {
    throw new Error(`Managed runtime SSH targets cannot be ${action} from SSH settings.`)
  }
}

/** Removing a managed host would strand its server; Stop proves the exit, Forget skips a dead host. */
export function assertNotManagedServerHost(targetId: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isManagedOrcadSshTarget(target)) {
    throw new Error(
      'This host runs a managed Orca server. Use Stop… under Settings › Managed servers to stop the server and remove it first, or Forget… there if the host is gone.'
    )
  }
}

/** What SSH settings may remove: no runtime-owned target and no managed server's host. */
export function assertSshTargetRemovable(targetId: string): void {
  assertNotRuntimeOwned(targetId, 'removed')
  assertNotManagedServerHost(targetId)
}

/** SSH settings' Add (`ssh:addTarget`); Pod's runtime RPC adds through it too. */
export function addSshTargetFromSettings(target: SshTargetCreateInput): {
  target: SshTarget
  repoReadoptions: SshRepoReadoption[]
} {
  const added = getSshTargetRegistryStore()!.addTarget(omitRendererSshTargetGeneration(target))
  // Why: re-adding a removed host can re-adopt orphaned workspaces; refresh the renderer's repo list so they move back onto the live host.
  const repoReadoptions = takeRepoReadoptions()
  return { target: added, repoReadoptions }
}

/** SSH settings' Save on an existing host (`ssh:updateTarget`). */
export function updateSshTargetFromSettings(
  id: string,
  updates: SshTargetUpdateInput
): SshTarget | null {
  assertNotRuntimeOwned(id, 'edited')
  const before = getSshTargetRegistryStore()!.getTarget(id)
  // The fence and generation are stripped, so a managed host keeps its server binding.
  const updated = getSshTargetRegistryStore()!.updateTarget(
    id,
    omitRendererSshTargetGeneration(updates)
  )
  const environmentId = getManagedOrcadFenceEnvironmentId(updated ?? undefined)
  if (environmentId && updated) {
    // Why: the tunnel and the SSH transport under it were built from the old fields, so both go
    // and the next use dials the edited target. Only a host reached through its managed server:
    // one an older build changed runs on the relay directly, whose session owns the transport.
    const redial =
      !allowsDirectSshRelay(updated) &&
      (!before || fingerprintRuntimeSshTarget(before) !== fingerprintRuntimeSshTarget(updated))
    void runTargetLifecycle(id, async () => {
      await closeOrcadManagedTunnel(environmentId)
      if (redial) {
        await connectionManager?.disconnect(id)
      }
    }).catch(() => undefined)
  }
  return updated
}

/** SSH settings' Remove (`ssh:removeTarget`), after the pane ended the host's terminals. */
export async function removeSshTargetFromSettings(id: string): Promise<void> {
  assertSshTargetRemovable(id)
  await removeRegisteredSshTarget(id)
}

/** SSH settings' sync with ~/.ssh/config (`ssh:importConfig`). */
export function importSshTargetsFromConfig(args?: { reAdopt?: boolean }): {
  targets: SshTarget[]
  repoReadoptions: SshRepoReadoption[]
} {
  const targets = getSshTargetRegistryStore()!.importFromSshConfig(args)
  const repoReadoptions = takeRepoReadoptions()
  return { targets, repoReadoptions }
}

export function registerSshTargetCrudHandlers(): void {
  ipcMain.handle('ssh:listTargets', () => {
    return getSshTargetRegistryStore()!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return getSshTargetRegistryStore()!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: SshTargetCreateInput }) =>
    addSshTargetFromSettings(args.target)
  )

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: SshTargetUpdateInput }) =>
      updateSshTargetFromSettings(args.id, args.updates)
  )

  ipcMain.handle('ssh:removeTarget', async (_event, args: { id: string }) => {
    await removeSshTargetFromSettings(args.id)
  })

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) =>
    importSshTargetsFromConfig(args)
  )

  // Why: add-host dialog picks one config entry to prefill the form; does not
  // mutate the target store (bulk sync stays on Settings → Import).
  ipcMain.handle('ssh:listConfigHosts', (_event, args?: SshConfigHostListArgs) => {
    return listUserSshConfigHostSummaries(
      getSshTargetRegistryStore()!.listTargets(),
      args?.query,
      getSshTargetRegistryStore()!.listSuppressedSshConfigAliases(),
      { refresh: args?.refresh === true }
    )
  })

  ipcMain.handle('ssh:resolveConfigHost', (_event, args: { alias: string }) => {
    return resolveUserSshConfigHost(args.alias)
  })
}
