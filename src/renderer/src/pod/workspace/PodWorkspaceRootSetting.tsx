import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, TriangleAlert } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  POD_WORKSPACE_DEFAULT_ROOT,
  type PodWorkspaceRootValidation
} from '../../../../shared/pod-workspace-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchableSetting } from '@/components/settings/SearchableSetting'
import { translate } from '@/i18n/i18n'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { getPodWorkspaceApi } from './pod-workspace-api-access'
import { rootIssueMessage } from './pod-workspace-copy'

const VALIDATE_DEBOUNCE_MS = 250

type PodWorkspaceRootSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function hasError(validation: PodWorkspaceRootValidation | null): boolean {
  return (
    validation !== null &&
    (validation.root === null || validation.issues.some((issue) => issue.severity === 'error'))
  )
}

export function PodWorkspaceRootSetting({
  settings,
  updateSettings
}: PodWorkspaceRootSettingProps): React.JSX.Element {
  const inputId = useId()
  const saved = settings.podWorkspaceRoot?.trim() || POD_WORKSPACE_DEFAULT_ROOT
  const [draft, setDraft] = useState(saved)
  const [validation, setValidation] = useState<PodWorkspaceRootValidation | null>(null)
  const validationGenRef = useRef(0)
  const skipNextBlurCommitRef = useRef(false)

  useEffect(() => {
    setDraft(saved)
  }, [saved])

  const validate = useCallback(
    async (value: string): Promise<PodWorkspaceRootValidation | null> => {
      const generation = ++validationGenRef.current
      const result = (await getPodWorkspaceApi()?.validateRoot(value)) ?? null
      if (generation === validationGenRef.current) {
        setValidation(result)
      }
      return result
    },
    []
  )

  // Why debounce: each check stats the path and may read Finder's iCloud preference.
  useEffect(() => {
    const timer = setTimeout(() => void validate(draft), VALIDATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, validate])

  // Why validate before saving: a refused root must never reach clone defaults or exclusions.
  const commit = async (value: string): Promise<void> => {
    const next = value.trim()
    if (next === saved) {
      return
    }
    const result = await validate(next)
    if (result && !hasError(result)) {
      updateSettings({ podWorkspaceRoot: next })
    }
  }

  const handleBrowse = async (): Promise<void> => {
    try {
      const picked = await window.api.repos.pickFolder()
      if (picked) {
        setDraft(picked)
        await commit(picked)
      }
    } finally {
      skipNextBlurCommitRef.current = false
    }
  }

  const issues = validation?.issues ?? []
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  return (
    <SearchableSetting
      title={translate('podWorkspace.root.title', 'Workspace root')}
      description={translate(
        'podWorkspace.root.description',
        'Clones go to <root>/<owner>/<repo>; projects without a remote owner go to <root>/_local.'
      )}
      keywords={['workspace', 'root', 'clone', 'folder', 'path', 'pod']}
      className="space-y-2"
    >
      <Label htmlFor={inputId}>{translate('podWorkspace.root.title', 'Workspace root')}</Label>
      <p className="text-xs text-muted-foreground">
        {translate(
          'podWorkspace.root.description',
          'Clones go to <root>/<owner>/<repo>; projects without a remote owner go to <root>/_local.'
        )}
      </p>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draft}
          aria-invalid={errors.length > 0}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (skipNextBlurCommitRef.current) {
              skipNextBlurCommitRef.current = false
              return
            }
            void commit(draft)
          }}
          onKeyDown={(event) => {
            if (isImeCompositionKeyDown(event)) {
              return
            }
            if (event.key === 'Enter') {
              skipNextBlurCommitRef.current = true
              void commit(draft)
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              skipNextBlurCommitRef.current = true
              setDraft(saved)
              event.currentTarget.blur()
            }
          }}
          className="flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={() => void handleBrowse()}
          className="shrink-0"
        >
          <FolderOpen className="size-3.5" />
          {translate('podWorkspace.root.browse', 'Browse')}
        </Button>
      </div>
      {errors.map((issue) => (
        <p key={issue.code} role="alert" className="text-xs text-destructive">
          {rootIssueMessage(issue.code)}
        </p>
      ))}
      {warnings.length > 0 ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2 text-status-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 space-y-1 text-xs leading-snug">
            {warnings.map((issue) => (
              <p key={issue.code}>{rootIssueMessage(issue.code)}</p>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {translate('podWorkspace.root.default', 'Default: {{root}}', {
          root: POD_WORKSPACE_DEFAULT_ROOT
        })}
      </p>
    </SearchableSetting>
  )
}
