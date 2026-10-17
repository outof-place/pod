// A stand-in for an Expo Metro (@expo/cli 58): `/status` sends the project root header at once and
// `packager-status:running` after a short warm-up; `/` with `expo-platform` answers a manifest
// whose launchAsset is `/index.bundle` here, and each bundle request is counted in
// `bundle-requests.log` in its folder; `/json/list` lists the apps whose JS runs on it, which a
// fake device's launch adds (`/fake/connect`) or, stopping at the dev launcher, removes
// (`/fake/disconnect`). argv: <port> [project root to claim]
//
// A loaded Mac, on demand: FAKE_METRO_LIST_STALL_MS makes every `/json/list` in that many ms from
// the first one answer after 2 s (past Pod's 1.5 s probe); FAKE_METRO_LIST_FLAKY answers that many
// first `/json/list` calls with a 500 and then an unparsable body, in turn; `/fake/busy?ms=` holds
// every `/status` unanswered for that long.
const http = require('node:http')
const fs = require('node:fs')

const port = Number(process.argv[2])
const root = process.argv[3] || fs.realpathSync(process.cwd())
const readyAt = Date.now() + 150
const pages = new Map()
const listStallMs = Number(process.env.FAKE_METRO_LIST_STALL_MS || 0)
let listFlaky = Number(process.env.FAKE_METRO_LIST_FLAKY || 0)
let firstListAt = null
let busyUntil = 0

function list(res) {
  if (listFlaky > 0) {
    listFlaky -= 1
    if (listFlaky % 2 === 1) {
      res.statusCode = 500
      res.end('reloading')
    } else {
      res.end('[{"appId": ')
    }
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify([...pages.values()]))
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/status') {
      if (Date.now() < busyUntil) {
        return
      }
      res.setHeader('X-React-Native-Project-Root', encodeURI(root))
      res.flushHeaders()
      setTimeout(() => res.end('packager-status:running'), Math.max(0, readyAt - Date.now()))
    } else if (url.pathname === '/' && req.headers['expo-platform'] === 'ios') {
      res.setHeader('Content-Type', 'application/expo+json')
      const bundle = `http://${req.headers.host}/index.bundle?platform=ios&dev=true`
      res.end(JSON.stringify({ launchAsset: { url: bundle } }))
    } else if (url.pathname === '/index.bundle') {
      fs.appendFileSync('bundle-requests.log', `${url.search}\n`)
      setTimeout(() => res.end('__d(function(){})'), 50)
    } else if (url.pathname === '/json/list') {
      firstListAt ??= Date.now()
      if (Date.now() - firstListAt < listStallMs) {
        setTimeout(() => list(res), 2_000)
      } else {
        list(res)
      }
    } else if (url.pathname === '/fake/busy') {
      busyUntil = Date.now() + Number(url.searchParams.get('ms') || 0)
      res.end()
    } else if (url.pathname === '/fake/connect' || url.pathname === '/fake/disconnect') {
      const appId = url.searchParams.get('appId')
      const deviceName = url.searchParams.get('deviceName')
      pages.delete(`${appId} ${deviceName}`)
      if (url.pathname === '/fake/connect') {
        pages.set(`${appId} ${deviceName}`, { id: `${pages.size}`, appId, deviceName })
      }
      res.end()
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  .listen(port)
