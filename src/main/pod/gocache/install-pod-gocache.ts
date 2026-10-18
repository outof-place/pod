import { join } from 'node:path'
import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getProductIdentity } from '../../product-identity/product-identity'
import { runAfterFirstWindowShown } from '../../startup/first-window-deferral'
import { hydrateShellPath } from '../../startup/hydrate-shell-path'
import { mainProcessState as state } from '../../startup/main-process-state'
import { automatedLaunchEnv } from '../acc/acc-lifecycle'
import { appBundlePath } from '../acc/acc-supervisor'
import { accountHome } from '../instance/pod-instance'
import { isPodHeadlessUiHost } from '../ui-host/pod-ui-host-launch'
import { loginShellPath } from './pod-gocache-go-env'
import { runPodGoCacheLifecycle, type PodGoCacheLifecycleOutcome } from './pod-gocache-lifecycle'
import { podGoCacheBundledHelperPath } from './pod-gocache-paths'
import { setPodGoCacheSettingReader } from './pod-gocache-pty-env'
import { POD_GOCACHE_ENV, isPodGoCacheSettingOn } from './pod-gocache-switch'

// Off the startup path like claude-acc's install; a headless runtime has no window to wait for.
const FIRST_WINDOW_FALLBACK_MS = 15_000

let started = false

function describe(outcome: PodGoCacheLifecycleOutcome): string {
  const d = outcome.decision
  switch (outcome.status) {
    case 'skipped':
      return `pod-gocache: skipped (${d.action === 'skip' ? d.reason : ''})`
    case 'up-to-date':
      return `pod-gocache: ${d.action === 'up-to-date' ? d.version : ''} is installed${outcome.kickstarted ? ', daemon started' : ''}`
    case 'busy':
      return 'pod-gocache: another Pod is installing it'
    case 'dry-run':
      return `pod-gocache: would ${d.action === 'install' ? `install ${d.version} (${d.reason})` : d.action === 'remove' ? 'remove the agent' : 'do nothing'}`
    case 'refused':
      return `pod-gocache: install refused: ${outcome.message}`
    case 'removed':
      return `pod-gocache: agent removed (setting off): ${outcome.message}`
    case 'installed':
    case 'failed':
      return d.action === 'remove'
        ? `pod-gocache: removal failed${outcome.exit === null ? '' : ` (exit ${outcome.exit})`}: ${outcome.message}`
        : `pod-gocache: install ${outcome.status} (${d.action === 'install' ? `${d.reason} → ${d.version}` : ''}${outcome.exit === null ? '' : `, exit ${outcome.exit}`}): ${outcome.message}`
  }
}

/** The terminal env follows the setting from the first spawn; the install runs after the first window, never in a plain `serve`. */
export function installPodGoCache(store: { getSettings(): GlobalSettings }): void {
  setPodGoCacheSettingReader(() => isPodGoCacheSettingOn(store.getSettings()))
  if (started || process.platform !== 'darwin' || (state.isServeMode && !isPodHeadlessUiHost())) {
    return
  }
  started = true
  runAfterFirstWindowShown(() => void startPodGoCacheLifecycle(store), FIRST_WINDOW_FALLBACK_MS)
}

async function startPodGoCacheLifecycle(store: { getSettings(): GlobalSettings }): Promise<void> {
  try {
    // the startup login-shell probe's cached PATH: a terminal's go, not the GUI launch's
    const shell = await hydrateShellPath()
    const account = accountHome()
    const identity = getProductIdentity()
    const outcome = await runPodGoCacheLifecycle(
      {
        platform: process.platform,
        home: app.getPath('home'),
        accountHome: account,
        userDataPath: app.getPath('userData'),
        // the profile applyProductIdentityPreReady pins, anchored at the account home
        defaultUserDataPath:
          account && identity?.userDataName
            ? join(account, 'Library', 'Application Support', identity.userDataName)
            : null,
        bundledHelper: podGoCacheBundledHelperPath(process.resourcesPath),
        uid: process.getuid?.() ?? null,
        bundleId: identity?.appId ?? null,
        appPath: appBundlePath(process.execPath),
        mode: process.env[POD_GOCACHE_ENV],
        settingEnabled: isPodGoCacheSettingOn(store.getSettings()),
        automatedBy: automatedLaunchEnv(process.env),
        goEnv: { ...process.env, PATH: loginShellPath(shell.segments, process.env.PATH) }
      },
      (spec) => runProcess(spec, 'tail')
    )
    console.log(`[pod] ${describe(outcome)}`)
  } catch (error) {
    console.warn(`[pod] pod-gocache: lifecycle threw: ${String(error)}`)
  }
}
