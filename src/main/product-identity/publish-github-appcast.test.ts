import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', '..', 'product', 'scripts', 'publish-github-appcast.sh')
// 1.0.0-rc5, product/update-host/update-host.sh's POD_BRIDGE_VERSION.
const BRIDGE = '1000005'
const HOST_DMG = 'https://updates.pod.codes/Pod-1.0.0-rc5.dmg'

// A GitHub release in a directory: assets/<id>/{name,data}, download/<name> as the download URLs
// serve them. Like GitHub, it refuses a second asset or a rename onto a name that is taken.
const FAKE_GH = `#!/bin/bash
set -euo pipefail
s=$FAKE_GH
echo "$*" >>"$s/calls.log"
taken() { local d; for d in "$s"/assets/*/; do [ -d "$d" ] && [ "$(cat "$d/name")" = "$1" ] && return 0; done; return 1; }
case "$1 $2" in
  "api repos/outof-place/pod/releases/tags/appcast")
    for d in "$s"/assets/*/; do [ -d "$d" ] && echo "$(basename "$d") $(cat "$d/name")"; done; true ;;
  "api -X")
    id=\${4##*/}
    case "$3" in
      PATCH)
        name=\${6#name=}
        [ "\${FAKE_GH_FAIL_RENAME_ID:-}" != "$id" ] || { echo "HTTP 502" >&2; exit 1; }
        ! taken "$name" || { echo "HTTP 422 already_exists" >&2; exit 1; }
        echo "$name" >"$s/assets/$id/name"; echo "$name" ;;
      DELETE) rm -rf "$s/assets/$id" ;;
    esac ;;
  "release upload")
    [ "\${FAKE_GH_FAIL_UPLOAD:-0}" != 1 ] || { echo "upload failed" >&2; exit 1; }
    name=$(basename "$4")
    ! taken "$name" || { echo "HTTP 422 already_exists" >&2; exit 1; }
    id=$(cat "$s/next"); echo $((id + 1)) >"$s/next"
    mkdir "$s/assets/$id"; echo "$name" >"$s/assets/$id/name"; cp "$4" "$s/assets/$id/data"
    [ "\${FAKE_GH_CORRUPT_UPLOAD:-0}" != 1 ] || echo "<!-- -->" >>"$s/assets/$id/data" ;;
  "release download")
    cp "$s/download/$7" "$9/" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
rm -rf "$s/download"; mkdir "$s/download"
for d in "$s"/assets/*/; do [ -d "$d" ] && cp "$d/data" "$s/download/$(cat "$d/name")"; done; true
`

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function appcast(build: string, archive = HOST_DMG): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n` +
    `<item><sparkle:version>${build}</sparkle:version><enclosure url="${archive}" length="1"/></item>\n` +
    `</channel></rss>\n`
  )
}

type Run = { state: string; shims: string; feed: string; host: string }

/**
 * A release whose assets are `existing` (name -> content), and an update host that already serves
 * `feed`; returns the paths the run needs.
 */
function release(existing: Record<string, string>, feed = appcast(BRIDGE)): Run {
  root = mkdtempSync(join(tmpdir(), 'pod-publish-github-appcast-'))
  const state = join(root, 'release')
  const shims = join(root, 'bin')
  mkdirSync(join(state, 'assets'), { recursive: true })
  mkdirSync(join(state, 'download'))
  mkdirSync(shims)
  writeFileSync(join(shims, 'gh'), FAKE_GH)
  // The script's own cleanup tool, so its work directory goes with the test.
  writeFileSync(join(shims, 'pod-tmp-rm'), '#!/bin/bash\nrm -rf -- "$@"\n')
  chmodSync(join(shims, 'gh'), 0o755)
  chmodSync(join(shims, 'pod-tmp-rm'), 0o755)
  let id = 50
  for (const [name, data] of Object.entries(existing)) {
    mkdirSync(join(state, 'assets', String(id)))
    writeFileSync(join(state, 'assets', String(id), 'name'), `${name}\n`)
    writeFileSync(join(state, 'assets', String(id), 'data'), data)
    writeFileSync(join(state, 'download', name), data)
    id += 1
  }
  writeFileSync(join(state, 'next'), '100\n')
  const host = join(root, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'appcast.xml'), feed)
  writeFileSync(join(root, 'appcast.xml'), feed)
  return { state, shims, feed: join(root, 'appcast.xml'), host }
}

function publish(
  run: Run,
  env: Record<string, string> = {}
): { status: number | null; out: string } {
  const result = spawnSync('/bin/bash', [script, run.feed], {
    encoding: 'utf8',
    env: {
      PATH: `${run.shims}:/usr/bin:/bin`,
      HOME: run.state,
      FAKE_GH: run.state,
      POD_FEED_URL: `file://${run.state}/download/appcast.xml`,
      POD_UPDATE_READ_HOST: `file://${run.host}`,
      POD_PUBLISH_RETRY_SECONDS: '0',
      ...env
    }
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() }
}

function assets(state: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(state, 'assets')).map((id) => [
      readFileSync(join(state, 'assets', id, 'name'), 'utf8').trim(),
      readFileSync(join(state, 'assets', id, 'data'), 'utf8')
    ])
  )
}

describe('publish-github-appcast.sh', () => {
  it('replaces the live feed through a renamed upload, never by deleting it first', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    const result = publish(run)
    expect(result.status, result.out).toBe(0)
    expect(result.out).toContain('serves')
    expect(result.out).toContain('(sparkle:version 1000005)')
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast(BRIDGE) })
    const calls = readFileSync(join(run.state, 'calls.log'), 'utf8')
      .split('\n')
      .filter((call) => !call.startsWith('api repos/'))
    expect(calls.slice(0, 5)).toEqual([
      expect.stringMatching(
        /^release upload appcast .*\/appcast\.xml\.new --repo outof-place\/pod$/
      ),
      expect.stringMatching(/^release download appcast .*--pattern appcast\.xml\.new/),
      'api -X PATCH repos/outof-place/pod/releases/assets/50 -f name=appcast.xml.old --jq .name',
      'api -X PATCH repos/outof-place/pod/releases/assets/100 -f name=appcast.xml --jq .name',
      'api -X DELETE repos/outof-place/pod/releases/assets/50'
    ])
  })

  it('publishes the first feed into an empty release', () => {
    const run = release({})
    expect(publish(run).status).toBe(0)
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast(BRIDGE) })
  })

  it('leaves the live feed alone when the upload fails', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    expect(publish(run, { FAKE_GH_FAIL_UPLOAD: '1' }).out).toContain(
      'the upload failed; the feed is unchanged'
    )
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast('1000004') })
  })

  it('leaves the live feed alone when the upload comes back different', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    expect(publish(run, { FAKE_GH_CORRUPT_UPLOAD: '1' }).out).toContain('the feed is unchanged')
    expect(assets(run.state)['appcast.xml']).toBe(appcast('1000004'))
  })

  it('puts the old feed back when the new one cannot take its name', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    const result = publish(run, { FAKE_GH_FAIL_RENAME_ID: '100' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the old feed is back')
    expect(assets(run.state)['appcast.xml']).toBe(appcast('1000004'))
  })

  it('rolls the swap back while the feed URL still serves the old file, and only then keeps the old asset', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    // A download URL that never follows the rename keeps answering with the old feed.
    const stale = join(run.state, '..', 'stale')
    mkdirSync(stale)
    writeFileSync(join(stale, 'appcast.xml'), appcast('1000004'))
    const result = publish(run, { POD_FEED_URL: `file://${stale}/appcast.xml` })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the swap is rolled back')
    expect(assets(run.state)).toEqual({
      'appcast.xml': appcast('1000004'),
      'appcast.xml.new': appcast(BRIDGE)
    })
  })

  it('says so when a first feed never shows up', () => {
    const run = release({})
    const result = publish(run, { POD_FEED_URL: `file://${run.state}/nowhere/appcast.xml` })
    expect(result.status).toBe(1)
    expect(result.out).toContain('no old feed to go back to')
  })

  it('stops on a half-done earlier run', () => {
    const run = release({ 'appcast.xml.old': appcast('1000004') })
    expect(publish(run).out).toContain('appcast.xml.old is left from an earlier run')
  })

  it('refuses to run inside an agent', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    expect(publish(run, { CLAUDECODE: '1' }).out).toContain('run this in your own Terminal')
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast('1000004') })
  })

  it('writes nothing after the bridge release: a later one stays on the update host', () => {
    const rc6 = appcast('1000006', 'https://updates.pod.codes/Pod-1.0.0-rc6.dmg')
    const run = release({ 'appcast.xml': appcast(BRIDGE) }, rc6)
    const result = publish(run)
    expect(result.status).toBe(1)
    expect(result.out).toContain('last written for 1.0.0-rc5 (1000005), not 1000006')
    expect(existsSync(join(run.state, 'calls.log'))).toBe(false)
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast(BRIDGE) })
  })

  it('refuses a bridge whose archive is on GitHub, which goes private', () => {
    const github =
      'https://github.com/outof-place/pod/releases/download/v1.0.0-rc5/Pod-1.0.0-rc5.dmg'
    const run = release({ 'appcast.xml': appcast('1000004') }, appcast(BRIDGE, github))
    const result = publish(run)
    expect(result.status).toBe(1)
    expect(result.out).toContain('not on https://updates.pod.codes')
    expect(existsSync(join(run.state, 'calls.log'))).toBe(false)
  })

  it('waits for the update host: GitHub gets the bridge only once the host serves the same appcast', () => {
    const run = release({ 'appcast.xml': appcast('1000004') })
    writeFileSync(join(run.host, 'appcast.xml'), appcast('1000004'))
    const result = publish(run)
    expect(result.status).toBe(1)
    expect(result.out).toContain('run publish-update.sh first')
    expect(existsSync(join(run.state, 'calls.log'))).toBe(false)
    expect(assets(run.state)).toEqual({ 'appcast.xml': appcast('1000004') })
  })
})
