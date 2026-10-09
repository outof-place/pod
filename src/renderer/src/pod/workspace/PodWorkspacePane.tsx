import React, { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '@/components/ui/button'
import { SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getPodWorkspaceApi } from './pod-workspace-api-access'
import { PodWorkspaceHealth } from './PodWorkspaceHealth'
import { PodWorkspaceRepoList } from './PodWorkspaceRepoList'
import { PodWorkspaceRootSetting } from './PodWorkspaceRootSetting'
import { usePodWorkspaceStatus } from './use-pod-workspace-status'

type PodWorkspacePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PodWorkspacePane({
  settings,
  updateSettings
}: PodWorkspacePaneProps): React.JSX.Element {
  const { status, loading, error, refresh } = usePodWorkspaceStatus(settings.podWorkspaceRoot)
  const [excluding, setExcluding] = useState(false)

  const excludeBuildFolders = async (): Promise<void> => {
    setExcluding(true)
    try {
      const result = await getPodWorkspaceApi()?.excludeBuildFolders()
      if (result) {
        const backupsNote =
          result.destination === 'none'
            ? translate(
                'podWorkspace.timeMachine.excludedNoBackups',
                'Backups are not configured yet.'
              )
            : undefined
        if (result.failed.length > 0) {
          toast.error(
            translate(
              'podWorkspace.timeMachine.excludeFailed',
              '{{count}} build folders could not be excluded.',
              { count: result.failed.length }
            ),
            { description: backupsNote }
          )
        } else {
          toast.success(
            translate(
              'podWorkspace.timeMachine.excluded',
              'Excluded {{count}} build folders from Time Machine.',
              { count: result.excluded }
            ),
            { description: backupsNote }
          )
        }
      }
    } catch (caught) {
      toast.error(extractIpcErrorMessage(caught, String(caught)))
    } finally {
      setExcluding(false)
      await refresh(false)
    }
  }

  const openSpotlightSettings = (): void => {
    void getPodWorkspaceApi()
      ?.openSpotlightSettings()
      .then((opened) => {
        if (!opened) {
          toast.error(
            translate('podWorkspace.spotlight.openFailed', 'Could not open System Settings.')
          )
        }
      })
  }

  return (
    <div className="space-y-8">
      <PodWorkspaceRootSetting settings={settings} updateSettings={updateSettings} />
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('podWorkspace.health.title', 'Health')}
          description={translate(
            'podWorkspace.health.description',
            'Checked when this page opens.'
          )}
          action={
            <Button
              variant="outline"
              size="sm"
              className="w-32"
              disabled={loading}
              onClick={() => void refresh(true)}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {translate('podWorkspace.health.refresh', 'Check again')}
            </Button>
          }
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {status ? (
          <PodWorkspaceHealth
            status={status}
            excluding={excluding}
            onExclude={() => void excludeBuildFolders()}
            onOpenSpotlightSettings={openSpotlightSettings}
          />
        ) : loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('podWorkspace.health.loading', 'Checking the workspace root…')}
          </p>
        ) : null}
      </section>
      {status ? <PodWorkspaceRepoList status={status} /> : null}
    </div>
  )
}
