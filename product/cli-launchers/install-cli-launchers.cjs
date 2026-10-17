// The bundled `orca` launcher hard-codes Orca's executable and the CLI defaults to Orca's profile.
// It ships as `<cliName>` only (install-native-cli.cjs later keeps it as podx-node, the native
// front's Node fallback). Its env prefix is whatever the tree's launcher uses: POD_ once
// pod-decouple has run (an assembled main), ORCA_ on a bare product branch.
const { execFileSync } = require('node:child_process')
const { readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const CLI_LAUNCHER_ANCHOR = 'ELECTRON="$CONTENTS/MacOS/Orca"'
// Upstream keeps the path up to the FIRST `.app`. In one-app Pod the runtime is nested
// (Pod.app/Contents/Helpers/Pod Runtime.app), so that named the outer app's executable.
const APP_PATH_ANCHOR = 'echo "${SOURCE_DIR%%${SOURCE_DIR#*.app}}"'
const APP_PATH_INNERMOST = [
  '# Pod: the bundle that holds this bin/, the innermost .app when one is nested in another.',
  '\tif [[ $SOURCE_DIR == */Contents/* ]]; then echo "${SOURCE_DIR%/Contents/*}"; fi'
].join('\n')

function patchCliLauncher(text, executableName, userDataName, envPrefix) {
  for (const anchor of [CLI_LAUNCHER_ANCHOR, APP_PATH_ANCHOR]) {
    if (!text.includes(anchor)) {
      throw new Error(`product: the CLI launcher no longer contains ${anchor}`)
    }
  }
  const prefix = envPrefix && text.includes(`${envPrefix}NODE_OPTIONS`) ? envPrefix : 'ORCA_'
  const defaultUserData = `$HOME/Library/Application Support/${userDataName}`
  return text
    .replace(APP_PATH_ANCHOR, () => APP_PATH_INNERMOST)
    .replace(CLI_LAUNCHER_ANCHOR, () =>
      [
        `ELECTRON="$CONTENTS/MacOS/${executableName}"`,
        ...(prefix === 'ORCA_' ? [] : legacyUserDataLines(prefix, defaultUserData, userDataName)),
        `export ${prefix}USER_DATA_PATH="\${${prefix}USER_DATA_PATH:-${defaultUserData}}"`
      ].join('\n')
    )
}

// A terminal opened before the decouple update has only ORCA_USER_DATA_PATH. It counts only in a
// Pod terminal, both paths resolved: an Orca.app terminal's names Orca's runtime and token, so
// the CLI refuses it.
// TODO(pod): drop the fallback after 2026-12-31, no earlier than the release after the decouple.
function legacyUserDataLines(prefix, defaultUserData, userDataName) {
  return [
    `if [ -z "\${${prefix}USER_DATA_PATH-}" ] && [ -n "\${ORCA_USER_DATA_PATH-}" ]; then`,
    '\tlegacy_user_data=$(cd -P -- "$ORCA_USER_DATA_PATH" 2>/dev/null && pwd -P) || legacy_user_data=',
    `\tpod_user_data=$(cd -P -- "${defaultUserData}" 2>/dev/null && pwd -P) || pod_user_data=`,
    '\tif [ -n "$pod_user_data" ] && case "$legacy_user_data/" in "$pod_user_data"/*) true ;; *) false ;; esac; then',
    `\t\t${prefix}USER_DATA_PATH=$ORCA_USER_DATA_PATH`,
    '\telse',
    `\t\techo "\${0##*/}: no ${userDataName} runtime in env: ORCA_USER_DATA_PATH is another app's data ($ORCA_USER_DATA_PATH)" >&2`,
    '\t\texit 1',
    '\tfi',
    'fi'
  ]
}

function installCliLaunchers(resourcesDir, executableName, identity) {
  const launcherPath = join(resourcesDir, 'bin', 'orca')
  const productLauncher = join(resourcesDir, 'bin', identity.cliName)
  writeFileSync(
    productLauncher,
    patchCliLauncher(
      readFileSync(launcherPath, 'utf8'),
      executableName,
      identity.userDataName,
      identity.envPrefix
    )
  )
  execFileSync('chmod', ['755', productLauncher])
  // Why drop it: a bare `orca` would be Orca's name for Pod's CLI.
  if (identity.cliName !== 'orca') {
    unlinkSync(launcherPath)
  }
}

module.exports = { installCliLaunchers, patchCliLauncher }
