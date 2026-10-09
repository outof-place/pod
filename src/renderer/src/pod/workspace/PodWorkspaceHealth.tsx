import React from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import type { PodWorkspaceStatus } from '../../../../shared/pod-workspace-types'
import { Button } from '@/components/ui/button'
import { SettingsRow } from '@/components/settings/SettingsFormControls'
import { formatBytes } from '@/components/status-bar/workspace-space-format'
import { translate } from '@/i18n/i18n'
import {
  spotlightDetail,
  spotlightStateLabel,
  timeMachineDestinationDetail
} from './pod-workspace-copy'
import { CheckValue, displayPathUnderRoot } from './pod-workspace-display'

// Below this a single install of a large monorepo can fill the disk.
const LOW_FREE_SPACE_BYTES = 20 * 1024 ** 3
const MISSING_PREVIEW_COUNT = 5

type PodWorkspaceHealthProps = {
  status: PodWorkspaceStatus
  excluding: boolean
  onExclude: () => void
  onOpenSpotlightSettings: () => void
}

function VolumeRows({ status }: { status: PodWorkspaceStatus }): React.JSX.Element {
  const { volume } = status
  return (
    <>
      <SettingsRow
        label={translate('podWorkspace.volume.pnpm.label', 'Same volume as the pnpm store')}
        description={translate(
          'podWorkspace.volume.pnpm.description',
          'pnpm clones packages from {{store}} only within one volume.',
          { store: volume.pnpmStoreDir }
        )}
        control={
          volume.sameVolumeAsPnpmStore === null ? (
            <CheckValue tone="neutral">{translate('podWorkspace.unknown', 'Unknown')}</CheckValue>
          ) : volume.sameVolumeAsPnpmStore ? (
            <CheckValue tone="ok">
              {translate('podWorkspace.volume.pnpm.same', 'Same volume')}
            </CheckValue>
          ) : (
            <CheckValue tone="warn">
              {translate('podWorkspace.volume.pnpm.different', 'Different volume')}
            </CheckValue>
          )
        }
      />
      <SettingsRow
        label={translate('podWorkspace.volume.case.label', 'Letter case')}
        description={translate(
          'podWorkspace.volume.case.description',
          'On a case-insensitive volume, README and readme name the same file.'
        )}
        control={
          <CheckValue tone="neutral">
            {volume.caseSensitive === null
              ? translate('podWorkspace.unknown', 'Unknown')
              : volume.caseSensitive
                ? translate('podWorkspace.volume.case.sensitive', 'Case-sensitive')
                : translate('podWorkspace.volume.case.insensitive', 'Case-insensitive')}
          </CheckValue>
        }
      />
      <SettingsRow
        label={translate('podWorkspace.volume.free.label', 'Free space')}
        control={
          volume.freeBytes === null || volume.totalBytes === null ? (
            <CheckValue tone="neutral">{translate('podWorkspace.unknown', 'Unknown')}</CheckValue>
          ) : (
            <CheckValue tone={volume.freeBytes < LOW_FREE_SPACE_BYTES ? 'warn' : 'neutral'}>
              {translate('podWorkspace.volume.free.value', '{{free}} free of {{total}}', {
                free: formatBytes(volume.freeBytes),
                total: formatBytes(volume.totalBytes)
              })}
            </CheckValue>
          )
        }
      />
    </>
  )
}

function SpotlightRow({
  status,
  onOpenSpotlightSettings
}: Pick<PodWorkspaceHealthProps, 'status' | 'onOpenSpotlightSettings'>): React.JSX.Element {
  const { spotlight } = status
  return (
    <div className="space-y-2 py-3">
      <SettingsRow
        className="py-0"
        label={translate('podWorkspace.spotlight.label', 'Spotlight')}
        description={spotlightDetail(spotlight, status.root)}
        alignTop
        control={
          <CheckValue
            tone={
              spotlight.state === 'excluded'
                ? 'ok'
                : spotlight.state === 'indexed'
                  ? 'warn'
                  : 'neutral'
            }
          >
            {spotlightStateLabel(spotlight.state)}
          </CheckValue>
        }
      />
      {spotlight.state === 'indexed' ? (
        <Button variant="outline" size="sm" onClick={onOpenSpotlightSettings}>
          <ExternalLink className="size-3.5" />
          {translate('podWorkspace.spotlight.open', 'Open Spotlight Settings')}
        </Button>
      ) : null}
    </div>
  )
}

function TimeMachineRow({
  status,
  excluding,
  onExclude
}: Pick<PodWorkspaceHealthProps, 'status' | 'excluding' | 'onExclude'>): React.JSX.Element {
  const { timeMachine } = status
  const missing = timeMachine.missing.length
  const total = missing + timeMachine.excluded.length
  return (
    <div className="space-y-2 py-3">
      <SettingsRow
        className="py-0"
        label={translate('podWorkspace.timeMachine.label', 'Time Machine')}
        description={timeMachineDestinationDetail(timeMachine.destination)}
        alignTop
        control={
          total === 0 ? (
            <CheckValue tone="neutral">
              {translate('podWorkspace.timeMachine.none', 'No build folders yet')}
            </CheckValue>
          ) : (
            <CheckValue tone={missing > 0 ? 'warn' : 'ok'}>
              {translate(
                'podWorkspace.timeMachine.counts',
                '{{excluded}} of {{total}} build folders excluded',
                { excluded: timeMachine.excluded.length, total }
              )}
            </CheckValue>
          )
        }
      />
      {missing > 0 ? (
        <div className="space-y-2">
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {timeMachine.missing.slice(0, MISSING_PREVIEW_COUNT).map((path) => (
              <li key={path} className="truncate">
                {displayPathUnderRoot(path, status.rootAliases)}
              </li>
            ))}
            {missing > MISSING_PREVIEW_COUNT ? (
              <li>
                {translate('podWorkspace.timeMachine.more', '+{{count}} more', {
                  count: missing - MISSING_PREVIEW_COUNT
                })}
              </li>
            ) : null}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="w-48"
            disabled={excluding}
            onClick={onExclude}
          >
            {excluding ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate('podWorkspace.timeMachine.exclude', 'Exclude build folders')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function PodWorkspaceHealth(props: PodWorkspaceHealthProps): React.JSX.Element {
  return (
    <div
      data-testid="pod-workspace-health"
      className="divide-y divide-border/60 rounded-lg border border-border/60 px-3"
    >
      <VolumeRows status={props.status} />
      <SpotlightRow status={props.status} onOpenSpotlightSettings={props.onOpenSpotlightSettings} />
      <TimeMachineRow
        status={props.status}
        excluding={props.excluding}
        onExclude={props.onExclude}
      />
      <SettingsRow
        label={translate('podWorkspace.index.label', 'Search index')}
        description={
          props.status.indexConnected
            ? translate(
                'podWorkspace.index.connectedDescription',
                'Repository rows show what the index holds for each checkout.'
              )
            : translate(
                'podWorkspace.index.disconnectedDescription',
                'The search index is not connected, so no index state is shown.'
              )
        }
        control={
          <CheckValue tone={props.status.indexConnected ? 'ok' : 'neutral'}>
            {props.status.indexConnected
              ? translate('podWorkspace.index.connected', 'Connected')
              : translate('podWorkspace.index.disconnected', 'Not connected')}
          </CheckValue>
        }
      />
    </div>
  )
}
