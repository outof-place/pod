// Fork-only (Pod): the status bar's Claude switcher lists claude-acc's accounts and switches through
// `claude-acc`, so Pod never stores a selection of its own. English only, as Settings' section.
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type {
  PodClaudeAccAccount,
  PodClaudeAccState
} from '../../../../shared/pod-claude-acc-accounts'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

/** Pod profile rows are usage only: claude-acc never switches to them. */
export function podClaudeAccSwitchRows(state: PodClaudeAccState | null): PodClaudeAccAccount[] {
  return (state?.accounts ?? []).filter((account) => !account.podProfile)
}

export function PodClaudeAccSwitcherMenu({
  claude,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  claude: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<PodClaudeAccState | null>(null)
  const [busyEmail, setBusyEmail] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const next = await window.api.podClaudeAcc.list()
    if (mountedRef.current) {
      setState(next)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (nextOpen) {
        void load()
      } else {
        setExpanded(false)
      }
    },
    [load]
  )

  const handleRow = async (account: PodClaudeAccAccount): Promise<void> => {
    if (busyEmail !== null) {
      return
    }
    setBusyEmail(account.email)
    try {
      const result = account.needsSignIn
        ? await window.api.podClaudeAcc.signInAgain(account.email)
        : await window.api.podClaudeAcc.switchTo(account.email)
      if (mountedRef.current) {
        setState(result.state)
      }
      if (!result.ok && !result.cancelled) {
        toast.error('Claude account update failed.', { description: result.message })
      }
    } catch (error) {
      toast.error('Claude account update failed.', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (mountedRef.current) {
        setBusyEmail(null)
      }
    }
  }

  const rows = podClaudeAccSwitchRows(state)
  const active = rows.find((account) => account.active)
  return (
    <ProviderDetailsMenu
      provider={claude}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel="Open Claude details and account switcher"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DropdownMenuLabel>Claude Account</DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          setExpanded((value) => !value)
        }}
      >
        <span className="max-w-[180px] truncate text-[12px] text-foreground">
          {active?.email ?? 'No claude-acc account in use'}
        </span>
        {expanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {expanded ? (
        <div className="px-1 pb-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Switch to
          </div>
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
            {rows.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {state?.available ? 'No accounts' : "claude-acc hasn't checked accounts yet"}
              </div>
            ) : null}
            {rows.map((account) => (
              <DropdownMenuItem
                key={account.email}
                disabled={busyEmail !== null || account.active}
                onSelect={(event) => {
                  event.preventDefault()
                  void handleRow(account)
                }}
              >
                <div className="flex w-full flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{account.email}</span>
                    {busyEmail === account.email ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" />
                    ) : account.active ? (
                      <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                        Active
                      </span>
                    ) : null}
                  </div>
                  {account.needsSignIn ? (
                    <span className="text-[10px] leading-4 text-muted-foreground">
                      Sign in again to use this account
                    </span>
                  ) : null}
                </div>
              </DropdownMenuItem>
            ))}
          </div>
          <div className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
            claude-acc switches the Claude login your sessions use.
          </div>
        </div>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-claude' })
          openSettingsPage()
        }}
      >
        Manage Accounts…
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
