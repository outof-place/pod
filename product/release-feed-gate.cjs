// Release feed gate: each release feeds one updater. A classic Pod.app (this Electron app at the
// top) updates through electron-updater's latest-mac.yml; a one-app Pod.app (PodNative outside,
// this app as a Contents/Helpers runtime) through Sparkle's appcast.xml. A classic install must
// never be offered a one-app build: Squirrel would download it and fail it against the other bundle
// id. Sparkle must never be offered a classic build. release.sh runs this before notarizing.
//
//   node product/release-feed-gate.cjs <app id> <Pod.app> <asset>...
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const SPARKLE_FEED = 'appcast.xml'
// electron-updater's channel files: latest-mac.yml, beta-mac.yml, ...
const CLASSIC_FEED = /-mac\.yml$/

function plistText(path) {
  const bytes = readFileSync(path)
  return bytes.subarray(0, 6).toString() === 'bplist'
    ? execFileSync('plutil', ['-convert', 'xml1', '-o', '-', path], { encoding: 'utf8' })
    : bytes.toString('utf8')
}

function bundleIdentifier(app) {
  const plist = join(app, 'Contents', 'Info.plist')
  if (!existsSync(plist)) {
    return null
  }
  const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plistText(plist))
  return match ? match[1] : null
}

/** "classic" when the app is `appId`, "one-app" when a Contents/Helpers app is, else null. */
function appLayout(app, appId) {
  if (bundleIdentifier(app) === appId) {
    return 'classic'
  }
  const helpers = join(app, 'Contents', 'Helpers')
  const nested = existsSync(helpers)
    ? readdirSync(helpers).filter((name) => name.endsWith('.app'))
    : []
  return nested.some((name) => bundleIdentifier(join(helpers, name)) === appId) ? 'one-app' : null
}

function feedProblems(layout, assets) {
  const names = assets.map((asset) => basename(asset))
  const classicFeeds = names.filter((name) => CLASSIC_FEED.test(name))
  const hasAppcast = names.includes(SPARKLE_FEED)
  if (layout === 'one-app') {
    return [
      ...(classicFeeds.length > 0
        ? [
            `a one-app release must not publish ${classicFeeds.join(', ')}: classic installs would download it`
          ]
        : []),
      ...(hasAppcast
        ? []
        : [`a one-app release needs ${SPARKLE_FEED} (product/scripts/sparkle-appcast.sh)`])
    ]
  }
  if (layout === 'classic') {
    return [
      ...(hasAppcast
        ? [
            `a classic release must not publish ${SPARKLE_FEED}: Sparkle would install it over one-app installs`
          ]
        : []),
      ...(classicFeeds.length > 0 ? [] : ['a classic release needs latest-mac.yml'])
    ]
  }
  return ['the app is neither the product app nor one-app with the product app as a helper']
}

module.exports = { appLayout, feedProblems }

if (require.main === module) {
  const [appId, app, ...assets] = process.argv.slice(2)
  if (!appId || !app) {
    console.error('usage: node product/release-feed-gate.cjs <app id> <Pod.app> <asset>...')
    process.exit(2)
  }
  const layout = appLayout(app, appId)
  const problems = feedProblems(layout, assets)
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[release-feed-gate] ${problem}`)
    }
    process.exit(1)
  }
  console.log(
    `[release-feed-gate] ${layout} release, feed ${assets.map((asset) => basename(asset)).join(', ')}`
  )
}
