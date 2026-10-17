// A stand-in for an Expo Metro (@expo/cli 58): `/status` sends the project root header at once and
// `packager-status:running` after a short warm-up; `/` with `expo-platform` answers a manifest
// whose launchAsset is `/index.bundle` here, and each bundle request is counted in
// `bundle-requests.log` in its folder; `/json/list` lists the apps whose JS runs on it, which a
// fake device's launch adds (`/fake/connect`) or, stopping at the dev launcher, removes
// (`/fake/disconnect`). argv: <port> [project root to claim]
const http = require('node:http')
const fs = require('node:fs')

const port = Number(process.argv[2])
const root = process.argv[3] || fs.realpathSync(process.cwd())
const readyAt = Date.now() + 150
const pages = new Map()
http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/status') {
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
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify([...pages.values()]))
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
