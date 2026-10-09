// electron-builder config for the downstream product described by product/identity.json, layered
// over Orca's own config/electron-builder.config.cjs so every upstream resource, hook and guard runs.
//
//   POD_VERSION   app version (release builds take it from the tag; default: package.json version)
//   POD_ARCH      arm64 (default) or x64
//   POD_RELEASE=1 dmg + zip, notarized (with ORCA_MAC_RELEASE=1 for upstream's strict signing);
//                 otherwise a signed but unnotarized .app (`dir`) for local installs
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const base = require('../config/electron-builder.config.cjs')

const identity = JSON.parse(readFileSync(join(__dirname, 'identity.json'), 'utf8'))
const arch = process.env.POD_ARCH || 'arm64'
const isRelease = process.env.POD_RELEASE === '1'
const version = process.env.POD_VERSION || base.extraMetadata?.version

const CLI_LAUNCHER_ANCHOR = 'ELECTRON="$CONTENTS/MacOS/Orca"'

// The bundled `orca` launcher hard-codes Orca's executable and the CLI defaults to Orca's profile.
function patchCliLauncher(resourcesDir, executableName) {
  const launcherPath = join(resourcesDir, 'bin', 'orca')
  const text = readFileSync(launcherPath, 'utf8')
  if (!text.includes(CLI_LAUNCHER_ANCHOR)) {
    throw new Error(`product: ${launcherPath} no longer contains ${CLI_LAUNCHER_ANCHOR}`)
  }
  const patched = text.replace(
    CLI_LAUNCHER_ANCHOR,
    [
      `ELECTRON="$CONTENTS/MacOS/${executableName}"`,
      `export ORCA_USER_DATA_PATH="\${ORCA_USER_DATA_PATH:-$HOME/Library/Application Support/${identity.userDataName}}"`
    ].join('\n')
  )
  writeFileSync(launcherPath, patched)
}

module.exports = {
  ...base,
  appId: identity.appId,
  productName: identity.displayName,
  copyright: identity.copyright,
  protocols: [{ name: identity.displayName, schemes: identity.protocols }],
  extraMetadata: {
    ...base.extraMetadata,
    ...(version ? { version } : {}),
    // Pre-ready defaults (userData, keychain) then never resolve to Orca's "orca".
    name: identity.userDataName,
    // Kept for builds whose updater lacks the product feed: never fall back to the official feed.
    orcaOfficialUpdates: false
  },
  afterPack: async (context) => {
    await base.afterPack(context)
    if (context.electronPlatformName === 'darwin') {
      const resourcesDir = join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources'
      )
      patchCliLauncher(resourcesDir, context.packager.appInfo.productFilename)
    }
  },
  mac: {
    ...base.mac,
    hardenedRuntime: true,
    notarize: isRelease,
    extraResources: [
      ...base.mac.extraResources,
      { from: 'product/identity.json', to: 'product-identity.json' },
      { from: 'LICENSE', to: 'ORCA-LICENSE.txt' }
    ],
    artifactName: `${identity.displayName}-\${version}-\${arch}-mac.\${ext}`,
    target: isRelease
      ? [
          { target: 'dmg', arch: [arch] },
          { target: 'zip', arch: [arch] }
        ]
      : [{ target: 'dir', arch: [arch] }]
  },
  dmg: { ...base.dmg, artifactName: `${identity.displayName}-\${version}-\${arch}.\${ext}` },
  forceCodeSigning: isRelease,
  // Generates app-update.yml in the app and latest-mac.yml next to the release artifacts.
  publish: identity.updateFeed
    ? {
        provider: 'github',
        owner: identity.updateFeed.owner,
        repo: identity.updateFeed.repo,
        releaseType: 'release'
      }
    : null
}
