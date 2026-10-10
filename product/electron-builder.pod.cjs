// electron-builder config for the downstream product described by product/identity.json, layered
// over Orca's own config/electron-builder.config.cjs so every upstream resource, hook and guard runs.
// macOS only: the product ships no Windows or Linux artifacts.
//
//   POD_VERSION   app version (release builds take it from the tag; default: package.json version)
//   POD_ARCH      arm64 (default) or x64
//   POD_RELEASE=1 dmg + zip, notarized (with ORCA_MAC_RELEASE=1 for upstream's strict signing);
//                 otherwise a signed but unnotarized .app (`dir`) for local installs
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
// Why destructure: drop every non-mac platform and target section of the upstream config.
const {
  win: _win,
  nsis: _nsis,
  linux: _linux,
  appImage: _appImage,
  deb: _deb,
  rpm: _rpm,
  ...base
} = require('../config/electron-builder.config.cjs')

const { assertAppAsar, PRODUCT_FILE_EXCLUSIONS } = require('./release-bundle-gate.cjs')

const repoRoot = join(__dirname, '..')
// claude-acc payload and distro plugins (identity.claudeAcc); the file arrives with the pod/acc branch.
const podAccConfig = join(repoRoot, 'config', 'pod-acc-extra-resources.cjs')
const podAcc = existsSync(podAccConfig) ? require(podAccConfig) : null

// Releases must ship claude-acc (it throws without the payload); a local `dir` build or a config
// read by tests carries on without it, so loading this file never needs the fetched payload.
function podAccMacExtraResources() {
  if (!podAcc) {
    return []
  }
  try {
    return podAcc.podAccMacExtraResources()
  } catch (error) {
    if (isRelease) {
      throw error
    }
    console.warn(`[product] ${error.message}; this non-release build ships without claude-acc`)
    return []
  }
}
const identity = JSON.parse(readFileSync(join(__dirname, 'identity.json'), 'utf8'))
const arch = process.env.POD_ARCH || 'arm64'
const isRelease = process.env.POD_RELEASE === '1'
const version = process.env.POD_VERSION || base.extraMetadata?.version

const CLI_LAUNCHER_ANCHOR = 'ELECTRON="$CONTENTS/MacOS/Orca"'

// The bundled `orca` launcher hard-codes Orca's executable and the CLI defaults to Orca's profile.
// Pod terminals keep `orca` on PATH for agents and skills; `<cliName>` sits next to it for users.
function installCliLaunchers(resourcesDir, executableName) {
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
  const productLauncher = join(resourcesDir, 'bin', identity.cliName)
  copyFileSync(launcherPath, productLauncher)
  execFileSync('chmod', ['755', productLauncher])
}

// TCC lists the helper by its bundle name and shows its usage strings; the .app path stays what
// upstream code resolves. Runs before upstream's afterPack signs the helper.
function renameComputerUseHelper(resourcesDir) {
  const plist = join(resourcesDir, 'Orca Computer Use.app', 'Contents', 'Info.plist')
  if (!identity.computerUseDisplayName || !existsSync(plist)) {
    return
  }
  const text = readFileSync(plist, 'utf8')
    .replaceAll('Orca Computer Use', identity.computerUseDisplayName)
    .replaceAll('ask Orca ', `ask ${identity.displayName} `)
  writeFileSync(plist, text)
  execFileSync('plutil', ['-lint', '-s', plist])
}

// macOS shows these when a terminal tool asks for a permission on the app's behalf.
function productUsageDescriptions(extendInfo) {
  return Object.fromEntries(
    Object.entries(extendInfo ?? {}).map(([key, value]) => [
      key,
      key.endsWith('UsageDescription') && typeof value === 'string'
        ? value.replaceAll(/\bOrca\b/g, identity.displayName)
        : value
    ])
  )
}

// claude-acc (orcahost.py) reads this to find the product's names. Only what differs from Orca:
// the Claude accounts' keychain service, ~/.orca/agent-hooks and the data files stay shared.
function claudeAccHost() {
  return {
    userData: `~/Library/Application Support/${identity.userDataName}`,
    cli: identity.cliName
  }
}

/** The Orca base this build was cut from: upstream.json when the stack pinned one, else git. */
function readOrcaUpstream() {
  const pinned = join(repoRoot, 'upstream.json')
  if (existsSync(pinned)) {
    // pod-stack's pin: { ref, nearestTag }, a commit at or after that tag.
    const { tag, sha, ref, nearestTag } = JSON.parse(readFileSync(pinned, 'utf8'))
    return { tag: tag ?? (nearestTag ? `${nearestTag}+` : null), sha: sha ?? ref }
  }
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  for (const ref of ['origin/orca-main', 'upstream/main']) {
    try {
      return { tag: null, sha: git(['merge-base', 'HEAD', ref]) }
    } catch {}
  }
  return { tag: null, sha: git(['rev-parse', 'HEAD']) }
}

module.exports = {
  ...base,
  appId: identity.appId,
  productName: identity.displayName,
  copyright: identity.copyright,
  files: [
    ...base.files,
    ...PRODUCT_FILE_EXCLUSIONS,
    ...(podAcc ? podAcc.podAccFileExclusions : [])
  ],
  protocols: [{ name: identity.displayName, schemes: identity.protocols }],
  extraMetadata: {
    ...base.extraMetadata,
    ...(version ? { version } : {}),
    // Pre-ready defaults (userData, keychain) then never resolve to Orca's "orca".
    name: identity.packageName || identity.userDataName.toLowerCase(),
    ...(identity.homepage ? { homepage: identity.homepage } : {}),
    // Kept for builds whose updater lacks the product feed: never fall back to the official feed.
    orcaOfficialUpdates: false
  },
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'darwin') {
      throw new Error('product builds are macOS only')
    }
    const resourcesDir = join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    )
    // Before any signing: an oversized or polluted asar never reaches notarization.
    assertAppAsar(resourcesDir)
    renameComputerUseHelper(resourcesDir)
    await base.afterPack(context)
    installCliLaunchers(resourcesDir, context.packager.appInfo.productFilename)
    writeFileSync(
      join(resourcesDir, 'product-upstream.json'),
      `${JSON.stringify(readOrcaUpstream())}\n`
    )
  },
  mac: {
    ...base.mac,
    extendInfo: {
      ...productUsageDescriptions(base.mac.extendInfo),
      ClaudeAccHost: claudeAccHost()
    },
    hardenedRuntime: true,
    notarize: isRelease,
    extraResources: [
      ...base.mac.extraResources,
      { from: 'product/identity.json', to: 'product-identity.json' },
      { from: 'LICENSE', to: 'ORCA-LICENSE.txt' },
      // Rollback of the opt-in terminal handover, runnable with the app's own Node.
      { from: 'product/scripts/restore-orca-terminals.mjs', to: 'restore-orca-terminals.mjs' },
      ...podAccMacExtraResources()
    ],
    artifactName: `${identity.displayName}-\${version}-\${arch}-mac.\${ext}`,
    target: isRelease
      ? [
          { target: 'dmg', arch: [arch] },
          { target: 'zip', arch: [arch] }
        ]
      : [{ target: 'dir', arch: [arch] }]
  },
  dmg: {
    ...base.dmg,
    // A signed DMG is what `spctl -a -t open --context context:primary-signature` accepts.
    sign: isRelease,
    artifactName: `${identity.displayName}-\${version}-\${arch}.\${ext}`
  },
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
