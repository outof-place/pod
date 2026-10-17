import {
  buildPosixHookPayloadCapture,
  POSIX_HOOK_JSON_STDIN,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines
} from '../agent-hooks/hook-stdin-contract'
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  windowsRuntimePath = process.execPath
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      // Why (#9358/#9941): inherited delayed expansion eats `!` out of the percent-expanded
      // curl args, mangling paneKey and dropping worktreeId. `!` is legal in a Windows path.
      'setlocal DisableDelayedExpansion',
      'if /I "%POD_ANTIGRAVITY_EVENT%"=="Stop" (',
      '  echo {"decision":""}',
      ') else if /I "%POD_ANTIGRAVITY_EVENT%"=="PreToolUse" (',
      `  echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`,
      ') else (',
      '  echo {}',
      ')',
      'if defined POD_AGENT_HOOK_ENDPOINT if exist "%POD_AGENT_HOOK_ENDPOINT%" call "%POD_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      // The runtime path is fixed at installation; hook payloads stay on stdin.
      'set "ELECTRON_RUN_AS_NODE=1"',
      `if not defined POD_AGENT_HOOK_NODE set "POD_AGENT_HOOK_NODE=${windowsRuntimePath.replaceAll('%', '%%')}"`,
      '"%POD_AGENT_HOOK_NODE%" "%~dp0antigravity-hook-post.cjs" >nul 2>nul',
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    'case "$POD_ANTIGRAVITY_EVENT" in',
    '  Stop)',
    '    printf \'{"decision":""}\\n\'',
    '    ;;',
    '  PreToolUse)',
    `    printf '${ANTIGRAVITY_PRE_TOOL_USE_DECISION}\\n'`,
    '    ;;',
    '  *)',
    // Why: Antigravity accepts an empty JSON object for passive status hooks;
    // only the PreToolUse gate rejects it, and that branch answers above.
    '    printf "{}\\n"',
    '    ;;',
    'esac',
    // Why: some Antigravity events arrive without stdin but still need a
    // status post, so the shared capture maps empty input to an object.
    ...buildPosixHookPayloadCapture('empty-object', POSIX_HOOK_JSON_STDIN),
    ...buildPosixHookSpoolLines('antigravity', 'POD_ANTIGRAVITY_EVENT'),
    'if [ -n "$POD_AGENT_HOOK_ENDPOINT" ] && [ -r "$POD_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$POD_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$POD_AGENT_HOOK_PORT" ] || [ -z "$POD_AGENT_HOOK_TOKEN" ] || [ -z "$POD_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${POD_AGENT_HOOK_PORT}/hook/antigravity" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${POD_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${POD_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${POD_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${POD_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${POD_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${POD_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${POD_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "hook_event_name=${POD_ANTIGRAVITY_EVENT}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

export function getWindowsWrapperScript(eventName: string): string {
  return [
    '@echo off',
    // Why (#9358/#9941): `!` is legal in the hooks path, and inherited delayed expansion
    // eats it out of the percent-expanded `%~dp0` — the wrapper then misses the core and
    // silently falls back on every event. Same reason the core disables it.
    'setlocal DisableDelayedExpansion',
    `set "POD_ANTIGRAVITY_EVENT=${eventName}"`,
    'set "POD_ANTIGRAVITY_CORE=%~dp0antigravity-hook.cmd"',
    'if exist "%POD_ANTIGRAVITY_CORE%" (',
    '  call "%POD_ANTIGRAVITY_CORE%"',
    '  exit /b 0',
    ')',
    'if /I "%POD_ANTIGRAVITY_EVENT%"=="Stop" (',
    '  echo {"decision":""}',
    ') else if /I "%POD_ANTIGRAVITY_EVENT%"=="PreToolUse" (',
    `  echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`,
    ') else (',
    '  echo {}',
    ')',
    // Missing-core fallbacks obey the same outside-Orca stdin guard as the core.
    ...buildWindowsHookEnvironmentGuardLines(),
    'exit /b 0',
    ''
  ].join('\r\n')
}
