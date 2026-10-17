// Fork-only (Pod): the two things Pod asks a worktree's Metro over HTTP, always on 127.0.0.1.
//
// Readiness is Metro's own `/status` (@expo/cli 58.1.2 createMetroMiddleware.js): it sends
// `X-React-Native-Project-Root` (the app folder it serves) at once and `packager-status:running`
// once the bundler is ready, so Pod tells this worktree's Metro from another one on the port.
//
// The warm-up asks for the bundle the dev client will load, so its first launch finds it built (a
// cold Portivo bundle is tens of seconds). The bundle's URL is the one Expo's manifest names
// (`GET /` with `expo-platform: ios`, ManifestMiddleware.js `_resolveProjectSettingsAsync`), the same
// URL expo-dev-launcher loads after `--initialUrl`, so both ask Metro for one graph: Metro 0.87.1
// keeps a build in flight per graph id (IncrementalBundler.js initializeGraph sets
// `_revisionsByGraphId` before awaiting), and the app's request joins the warm-up's.
//
// Whether the app's JS runs on this Metro is its inspector's `/json/list` (@react-native/
// dev-middleware 0.88.0-rc.3 InspectorProxy.js): one page per running app, with the app's bundle id
// (`appId`) and the simulator's name (`deviceName`).
import { request, type IncomingHttpHeaders } from 'node:http'

/** What answers on a port: this app's Metro (ready or still starting), something else, nothing. */
export type SimMetroProbe = 'ready' | 'starting' | 'foreign' | 'unresponsive' | 'none'

const PROBE_TIMEOUT_MS = 1_500
const MANIFEST_TIMEOUT_MS = 30_000
const MANIFEST_MAX_BYTES = 1024 * 1024
/** A cold bundle on a loaded Mac. */
export const SIM_METRO_WARM_TIMEOUT_MS = 5 * 60_000

/** One GET /status: who serves the port. */
export function probeSimMetro(
  port: number,
  appDir: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<SimMetroProbe> {
  return new Promise((resolve) => {
    let answered = false
    const done = (probe: SimMetroProbe) => {
      if (!answered) {
        answered = true
        resolve(probe)
      }
      req.destroy()
    }
    const req = request(
      { host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: timeoutMs },
      (res) => {
        const header = res.headers['x-react-native-project-root']
        let root: string | null = null
        try {
          root = typeof header === 'string' ? decodeURI(header) : null
        } catch {
          root = null
        }
        if (root !== appDir) {
          res.resume()
          done('foreign')
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.includes('packager-status:running')) {
            done('ready')
          }
        })
        res.on('end', () => done(body.includes('packager-status:running') ? 'ready' : 'starting'))
        res.on('error', () => done('starting'))
      }
    )
    req.on('timeout', () => done('unresponsive'))
    req.on('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'ECONNREFUSED' ? 'none' : 'unresponsive')
    )
    req.end()
  })
}

type Got = { status: number; body: string; bytes: number }

/** GET on 127.0.0.1; the body kept up to `keep` bytes, the rest only counted. */
function get(
  port: number,
  path: string,
  headers: IncomingHttpHeaders,
  timeoutMs: number,
  keep: number
): Promise<Got | string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Got | string) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        if (bytes < keep) {
          chunks.push(chunk)
        }
        bytes += chunk.length
      })
      res.on('end', () =>
        finish({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).subarray(0, keep).toString('utf8'),
          bytes
        })
      )
      res.on('error', (error) => finish(error.message))
    })
    // The whole exchange, not one idle gap: a bundle streams slowly while it builds.
    const timer = setTimeout(() => {
      req.destroy()
      finish(`no answer within ${Math.round(timeoutMs / 1000)} s`)
    }, timeoutMs)
    req.on('error', (error) => finish(error.message))
    req.end()
  })
}

/** The bundle path the manifest names, when it names one on this Metro. */
function bundlePathOf(manifest: string, port: number): string | null {
  try {
    const parsed: unknown = JSON.parse(manifest)
    const launchAsset =
      parsed && typeof parsed === 'object' && 'launchAsset' in parsed ? parsed.launchAsset : null
    const raw =
      launchAsset && typeof launchAsset === 'object' && 'url' in launchAsset
        ? launchAsset.url
        : null
    if (typeof raw !== 'string') {
      return null
    }
    const url = new URL(raw, `http://127.0.0.1:${port}/`)
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return local && Number(url.port) === port ? `${url.pathname}${url.search}` : null
  } catch {
    return null
  }
}

export type SimMetroWarm =
  | Readonly<{ ok: true; ms: number; bytes: number }>
  | Readonly<{ ok: false; message: string }>

/** Has Metro on `port` build the iOS bundle its dev client asks for. */
export async function warmSimMetroBundle(
  port: number,
  timeoutMs = SIM_METRO_WARM_TIMEOUT_MS
): Promise<SimMetroWarm> {
  const begun = performance.now()
  const manifest = await get(
    port,
    '/',
    { 'expo-platform': 'ios', accept: 'application/expo+json' },
    MANIFEST_TIMEOUT_MS,
    MANIFEST_MAX_BYTES
  )
  if (typeof manifest === 'string' || manifest.status !== 200) {
    return {
      ok: false,
      message: `no Expo manifest on port ${port}: ${typeof manifest === 'string' ? manifest : `HTTP ${manifest.status}`}`
    }
  }
  const path = bundlePathOf(manifest.body, port)
  if (!path) {
    return { ok: false, message: `the manifest on port ${port} names no bundle on that port` }
  }
  const bundle = await get(port, path, {}, timeoutMs, 0)
  if (typeof bundle === 'string' || bundle.status !== 200) {
    return {
      ok: false,
      message: `the bundle on port ${port}: ${typeof bundle === 'string' ? bundle : `HTTP ${bundle.status}`}`
    }
  }
  return { ok: true, ms: Math.round(performance.now() - begun), bytes: bundle.bytes }
}

/**
 * Whether Metro on `port` lists the app's JS on that device: `noList` when this Metro has no
 * inspector list to ask, `noAnswer` when it did not answer in time (a loaded Mac; ask again).
 */
export async function simAppOnMetro(
  port: number,
  bundleId: string,
  deviceName: string | null,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean | 'noList' | 'noAnswer'> {
  const listed = await get(port, '/json/list', {}, timeoutMs, MANIFEST_MAX_BYTES)
  if (typeof listed === 'string') {
    return 'noAnswer'
  }
  if (listed.status !== 200) {
    return 'noList'
  }
  try {
    const pages: unknown = JSON.parse(listed.body)
    if (!Array.isArray(pages)) {
      return 'noList'
    }
    return pages.some((page: unknown) => {
      if (!page || typeof page !== 'object') {
        return false
      }
      const appId = 'appId' in page ? page.appId : null
      const name = 'deviceName' in page ? page.deviceName : null
      return appId === bundleId && (deviceName === null || name === deviceName)
    })
  } catch {
    return 'noList'
  }
}
