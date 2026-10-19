// Fork-only (Pod): Claude accounts are claude-acc's. Rows come from its account tick and every
// change runs `claude-acc`, so an account added here is switchable and in auto-switch. English only.
import { useCallback, useEffect, useState } from 'react'
import { ArrowRightLeft, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { getProductUiIdentity } from '@/lib/product-ui-identity'
import { cn } from '@/lib/utils'
import type {
  PodClaudeAccAccount,
  PodClaudeAccResult,
  PodClaudeAccState,
  PodClaudeAccWindow
} from '../../../../shared/pod-claude-acc-accounts'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { ClaudeIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'

export function isPodClaudeAccAccounts(): boolean {
  return (
    getProductUiIdentity() !== null && typeof window !== 'undefined' && !!window.api?.podClaudeAcc
  )
}

type Action = 'idle' | 'adding' | `signin:${string}` | `switch:${string}`
type Notice = { text: string; error: boolean }

// The tick rewrites its snapshot every 2 minutes; a quarter of that keeps the rows current.
const REFRESH_MS = 30_000

function percent(window: PodClaudeAccWindow | null): string | null {
  return window?.used == null ? null : `${Math.round(window.used)}%`
}

function usageLine(account: PodClaudeAccAccount): string {
  const week = percent(account.weekly)
  const session = percent(account.session)
  const usage = [week && `week ${week} used`, session && `5h ${session}`]
    .filter(Boolean)
    .join(' · ')
  return [usage, account.note].filter(Boolean).join(' · ')
}

export function PodClaudeAccAccountsSection(): React.JSX.Element {
  const [state, setState] = useState<PodClaudeAccState | null>(null)
  const [action, setAction] = useState<Action>('idle')
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.podClaudeAcc.list().then((next) => {
        if (live) {
          setState(next)
        }
      })
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const run = useCallback(
    async (next: Action, call: () => Promise<PodClaudeAccResult>, done: string): Promise<void> => {
      setAction(next)
      setNotice(null)
      try {
        const result = await call()
        setState(result.state)
        if (!result.cancelled) {
          setNotice(
            result.ok ? { text: done, error: false } : { text: result.message, error: true }
          )
        }
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
      } finally {
        setAction('idle')
      }
    },
    []
  )

  const busy = action !== 'idle'
  const accounts = state?.accounts ?? []
  return (
    <section key="claude-accounts" id="accounts-claude" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ClaudeIcon size={16} />
          {translate('podClaudeAcc.settings.heading', 'Claude')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'podClaudeAcc.settings.intro',
            'Claude accounts live in claude-acc, the same list as Pod Menu. Every account here is in auto-switch, and a switch moves the Claude login your sessions use.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate('podClaudeAcc.settings.title', 'Claude Accounts')}
        description={translate(
          'podClaudeAcc.settings.description',
          'Add, sign in again and switch Claude accounts through claude-acc.'
        )}
        keywords={['claude', 'account', 'claude-acc', 'switch', 'rate limit', 'quota']}
        className="space-y-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>{translate('podClaudeAcc.settings.accounts', 'Accounts')}</Label>
            <p className="text-xs text-muted-foreground">
              {action === 'adding'
                ? translate(
                    'podClaudeAcc.settings.addingHint',
                    'Finish signing in in your browser.'
                  )
                : translate(
                    'podClaudeAcc.settings.addHint',
                    'Add Account opens claude.ai in your browser.'
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void run('adding', () => window.api.podClaudeAcc.add(), 'Account added')
              }
              disabled={busy || !state?.available}
              className="gap-1.5"
            >
              {action === 'adding' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              {translate('podClaudeAcc.settings.add', 'Add Account')}
            </Button>
            {action === 'adding' || action.startsWith('signin:') ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void window.api.podClaudeAcc.cancel()}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                {translate('podClaudeAcc.settings.cancel', 'Cancel')}
              </Button>
            ) : null}
          </div>
        </div>

        {state?.podSelected ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'podClaudeAcc.settings.autoSwitchPaused',
              'Auto-switch is paused: Pod has {{profile}} selected for new Claude sessions. Choose System default in the Claude menu of the status bar to hand switching back to claude-acc.',
              { profile: state.podSelected }
            )}
          </p>
        ) : null}

        {notice ? (
          <p className={cn('text-xs', notice.error ? 'text-destructive' : 'text-muted-foreground')}>
            {notice.text}
          </p>
        ) : null}

        <div className="space-y-2">
          {accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
              {state?.available
                ? translate(
                    'podClaudeAcc.settings.empty',
                    'No Claude accounts yet. Add one, or sign in with /login in a Claude session: claude-acc takes that login over within 2 minutes.'
                  )
                : translate(
                    'podClaudeAcc.settings.notChecked',
                    "claude-acc hasn't checked accounts yet. It comes with Pod and checks every 2 minutes."
                  )}
            </div>
          ) : (
            accounts.map((account) => (
              <div
                key={account.email}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5',
                  account.active ? 'border-foreground/20 bg-accent/15' : 'border-border/70'
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.email}</span>
                    {account.active ? (
                      <Badge variant="outline" className="shrink-0">
                        {translate('podClaudeAcc.active', 'Active')}
                      </Badge>
                    ) : null}
                    {account.podProfile ? (
                      <Badge variant="outline" className="shrink-0">
                        {translate('podClaudeAcc.settings.podProfile', 'Pod profile · usage only')}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {account.needsSignIn
                      ? translate('podClaudeAcc.needsSignIn', 'Sign in again to use this account')
                      : usageLine(account)}
                  </span>
                </div>
                {account.podProfile ? null : (
                  <div className="flex shrink-0 items-center gap-1">
                    {account.active || account.needsSignIn ? null : (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void run(
                            `switch:${account.email}`,
                            () => window.api.podClaudeAcc.switchTo(account.email),
                            `Switched to ${account.email}`
                          )
                        }
                        disabled={busy}
                        className="h-6 px-2 text-muted-foreground hover:text-foreground"
                      >
                        {action === `switch:${account.email}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <ArrowRightLeft className="size-3" />
                        )}
                        {translate('podClaudeAcc.settings.switch', 'Switch')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        void run(
                          `signin:${account.email}`,
                          () => window.api.podClaudeAcc.signInAgain(account.email),
                          `Signed in ${account.email}`
                        )
                      }
                      disabled={busy}
                      className="h-6 px-2 text-muted-foreground hover:text-foreground"
                    >
                      {action === `signin:${account.email}` ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3" />
                      )}
                      {translate('podClaudeAcc.settings.signInAgain', 'Sign in again')}
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </SearchableSetting>
    </section>
  )
}
