import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const product = join(__dirname, '..', '..', '..', 'product')
const script = join(product, 'scripts', 'publish-update.sh')
const HOST = 'https://updates.pod.codes'

// Vercel in a directory: blob/<pathname> is the store, served/<n>/ what deployment n serves (its
// files, each root Pod-*.dmg and rehearsal/ of the store through the redirects), live the deployment
// on the domain. FAKE_VERCEL_NO_REDIRECT=1 deploys without the archives, FAKE_VERCEL_STALE_PROMOTE=<n>
// promotes deployment n without the domain ever serving it, FAKE_VERCEL_PROMOTE_FAILS=1 refuses every
// promote, FAKE_VERCEL_PROMOTE_409=1 answers 409 for a deployment the domain then serves,
// FAKE_VERCEL_SHORT_PUT=1 stores every upload cut short.
const FAKE_VERCEL = `#!/bin/bash
set -euo pipefail
s=$FAKE_VERCEL
echo "$*" >>"$s/calls.log"
oidc() {
  [ "\${VERCEL_OIDC_TOKEN:-}" = fake-oidc ] && [ "\${BLOB_STORE_ID:-}" = store_6oaqIaz38g6zR40k ] ||
    { echo "no Blob credentials" >&2; exit 1; }
}
serve() {
  local n=$1 dir=$s/served/$1 f
  mkdir -p "$dir"
  cp "$s/deployments/$n/appcast.xml" "$s/deployments/$n/robots.txt" "$dir/"
  ln -sfn "$s/blob/rehearsal" "$dir/rehearsal"
  [ "\${FAKE_VERCEL_NO_REDIRECT:-0}" = 1 ] && return 0
  for f in "$s"/blob/Pod-*.dmg; do [ -f "$f" ] && ln -sfn "$f" "$dir/\${f##*/}"; done
  return 0
}
case "$1 $2" in
  "env pull")
    [ -f .vercel/project.json ] || { echo "not linked" >&2; exit 1; }
    echo 'VERCEL_OIDC_TOKEN="fake-oidc"' >"$3" ;;
  "blob list")
    oidc
    prefix=$(sed -n 's/.*--prefix \\([^ ]*\\).*/\\1/p' <<<"$*")
    (cd "$s/blob" && find . -type f | sed 's|^\\./||' | sort) | python3 -I -c '
import json, os, sys
prefix, root = sys.argv[1], sys.argv[2]
names = [n for n in sys.stdin.read().split() if n.startswith(prefix)]
print(json.dumps({"blobs": [{"pathname": n, "size": os.path.getsize(os.path.join(root, n))} for n in names]}))
' "$prefix" "$s/blob" ;;
  "blob put")
    oidc
    [ "\${FAKE_VERCEL_FAIL_PUT:-0}" != 1 ] || { echo "upload failed" >&2; exit 1; }
    name=$(sed -n 's/.*--pathname \\([^ ]*\\).*/\\1/p' <<<"$*")
    if [ -e "$s/blob/$name" ] && [[ "$*" != *"--allow-overwrite true"* ]]; then
      echo "This blob already exists" >&2; exit 1
    fi
    mkdir -p "$(dirname "$s/blob/$name")"
    cp "$3" "$s/blob/$name"
    [ "\${FAKE_VERCEL_SHORT_PUT:-0}" != 1 ] || printf 'cut' >"$s/blob/$name" ;;
  "blob del")
    oidc
    rm -f "$s/blob/$3" ;;
  deploy*)
    n=$(cat "$s/next"); echo $((n + 1)) >"$s/next"
    cp -R "$2" "$s/deployments/$n"
    serve "$n"
    printf '{"id":"dpl_%s","url":"file://%s/served/%s"}\\n' "$n" "$s" "$n" ;;
  inspect*)
    [ -f "$s/live-id" ] || exit 1
    printf '{"id":"%s"}\\n' "$(cat "$s/live-id")" ;;
  promote*)
    n=\${2##*/}; n=\${n#dpl_}
    [ -d "$s/served/$n" ] || { echo "no deployment $2" >&2; exit 1; }
    [ "\${FAKE_VERCEL_STALE_PROMOTE:-}" = "$n" ] && exit 0
    [ "\${FAKE_VERCEL_PROMOTE_FAILS:-0}" != 1 ] || { echo "Error: promote failed" >&2; exit 1; }
    ln -sfn "$s/served/$n" "$s/live"; echo "dpl_$n" >"$s/live-id"
    [ "\${FAKE_VERCEL_PROMOTE_409:-0}" != 1 ] || { echo "Error: already the current production deployment. (409)" >&2; exit 1; } ;;
  *) echo "fake vercel: unexpected $*" >&2; exit 2 ;;
esac
`

const OLD_FEED = appcast('1000005', 'Pod-1.0.0-rc5.dmg', 3)

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function appcast(build: string, archive: string, length: number, host = HOST): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n` +
    `<item><sparkle:version>${build}</sparkle:version>` +
    `<enclosure url="${host}/${archive}" length="${length}" type="application/octet-stream"/></item>\n` +
    `</channel></rss>\n`
  )
}

type Run = { vercel: string; shims: string; release: string; dmg: string; feed: string }

/** Vercel whose domain serves rc5's feed, and rc6's release directory. */
function setup(options: { dmg?: string; feed?: string; artifacts?: string } = {}): Run {
  root = mkdtempSync(join(tmpdir(), 'pod-publish-update-'))
  const vercel = join(root, 'vercel')
  const shims = join(root, 'bin')
  for (const dir of ['blob/rehearsal', 'deployments/0', 'served', 'bin', 'release']) {
    mkdirSync(join(root, dir === 'bin' || dir === 'release' ? dir : `vercel/${dir}`), {
      recursive: true
    })
  }
  writeFileSync(join(shims, 'vercel'), FAKE_VERCEL)
  // The script's own cleanup tool, so its work directory goes with the test.
  writeFileSync(join(shims, 'pod-tmp-rm'), '#!/bin/bash\nrm -rf -- "$@"\n')
  chmodSync(join(shims, 'vercel'), 0o755)
  chmodSync(join(shims, 'pod-tmp-rm'), 0o755)
  writeFileSync(join(vercel, 'blob', 'Pod-1.0.0-rc5.dmg'), 'rc5')
  writeFileSync(join(vercel, 'deployments', '0', 'appcast.xml'), OLD_FEED)
  writeFileSync(join(vercel, 'deployments', '0', 'robots.txt'), '')
  mkdirSync(join(vercel, 'served', '0'))
  writeFileSync(join(vercel, 'served', '0', 'appcast.xml'), OLD_FEED)
  symlinkSync(join(vercel, 'blob', 'rehearsal'), join(vercel, 'served', '0', 'rehearsal'))
  symlinkSync(join(vercel, 'served', '0'), join(vercel, 'live'))
  writeFileSync(join(vercel, 'live-id'), 'dpl_0\n')
  writeFileSync(join(vercel, 'next'), '1\n')
  const release = join(root, 'release')
  const dmg = options.dmg ?? 'the rc6 disk image'
  writeFileSync(join(release, 'Pod-1.0.0-rc6.dmg'), dmg)
  const feed = options.feed ?? appcast('1000006', 'Pod-1.0.0-rc6.dmg', dmg.length)
  writeFileSync(join(release, 'appcast.xml'), feed)
  writeFileSync(
    join(release, 'artifacts.txt'),
    options.artifacts ?? 'Pod 1.0.0-rc6 (CFBundleVersion 1000006), tag v1.0.0-rc6 at abc\n'
  )
  return { vercel, shims, release, dmg, feed }
}

function run(
  r: Run,
  args: string[],
  env: Record<string, string> = {}
): { status: number | null; out: string } {
  const result = spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${r.shims}:/usr/bin:/bin`,
      HOME: r.vercel,
      FAKE_VERCEL: r.vercel,
      POD_UPDATE_READ_HOST: `file://${r.vercel}/live`,
      POD_PUBLISH_RETRY_SECONDS: '0',
      ...env
    }
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() }
}

function calls(r: Run): string[] {
  const log = join(r.vercel, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}

function live(r: Run): string {
  return readFileSync(join(r.vercel, 'live', 'appcast.xml'), 'utf8')
}

describe('publish-update.sh', () => {
  it('uploads the DMG, proves the deployment off the domain, then puts it on the domain', () => {
    const r = setup()
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(result.out).toContain(`${HOST}/appcast.xml serves`)
    expect(result.out).toContain('(sparkle:version 1000006)')
    expect(live(r)).toBe(r.feed)
    expect(readFileSync(join(r.vercel, 'blob', 'Pod-1.0.0-rc6.dmg'), 'utf8')).toBe(r.dmg)
    expect(readdirSync(join(r.vercel, 'deployments', '1')).sort()).toEqual([
      'appcast.xml',
      'robots.txt',
      'vercel.json'
    ])
    const [pull, list, put, deploy, inspect, promote, ...rest] = calls(r)
    expect([pull, list, put].map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual([
      'env pull',
      'blob list',
      'blob put'
    ])
    expect(deploy).toMatch(
      /^deploy \S+ --prod --skip-domain --project prj_\w+ --yes --json --scope outofplace$/
    )
    expect(inspect).toBe('inspect updates.pod.codes --json --scope outofplace')
    expect(promote).toMatch(/^promote file:\/\/\S+\/served\/1 --yes --scope outofplace$/)
    expect(rest).toEqual([])
  })

  it('finds the DMG of an earlier run in the store and uploads nothing', () => {
    const r = setup()
    writeFileSync(join(r.vercel, 'blob', 'Pod-1.0.0-rc6.dmg'), r.dmg)
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(calls(r).some((call) => call.startsWith('blob put'))).toBe(false)
    expect(live(r)).toBe(r.feed)
  })

  it('never replaces a published DMG, even one of the same size', () => {
    const r = setup()
    writeFileSync(join(r.vercel, 'blob', 'Pod-1.0.0-rc6.dmg'), 'x'.repeat(r.dmg.length))
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain('a published archive is never replaced')
    expect(readFileSync(join(r.vercel, 'blob', 'Pod-1.0.0-rc6.dmg'), 'utf8')).toBe(
      'x'.repeat(r.dmg.length)
    )
    expect(calls(r).some((call) => call.startsWith('promote'))).toBe(false)
    expect(live(r)).toBe(OLD_FEED)
  })

  it('leaves the feed alone when the upload fails', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_FAIL_PUT: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the feed is unchanged')
    expect(calls(r).some((call) => call.startsWith('deploy'))).toBe(false)
    expect(live(r)).toBe(OLD_FEED)
  })

  it('leaves the feed alone when the deployment does not serve the DMG', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_NO_REDIRECT: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('does not serve Pod-1.0.0-rc6.dmg through its redirect')
    expect(calls(r).some((call) => call.startsWith('promote'))).toBe(false)
    expect(live(r)).toBe(OLD_FEED)
  })

  it('puts the domain back on its previous deployment when it never serves the new feed', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_STALE_PROMOTE: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the domain is back on dpl_0')
    expect(calls(r)).toContain('promote dpl_0 --yes --scope outofplace')
    expect(live(r)).toBe(OLD_FEED)
  })

  it('takes a refused promote for done when the domain already serves the feed', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_PROMOTE_409: '1' })
    expect(result.status, result.out).toBe(0)
    expect(live(r)).toBe(r.feed)
  })

  it('says the feed is unchanged when a promote fails and the domain serves the old feed', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_PROMOTE_FAILS: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('vercel promote')
    expect(result.out).toContain('the feed is unchanged')
    expect(live(r)).toBe(OLD_FEED)
  })

  it("refuses a dry run's release: its throwaway key would lock installed Pods out", () => {
    const r = setup({
      artifacts: 'Pod 1.0.0-rc6 (CFBundleVersion 1000006), DRY RUN: never publish\n'
    })
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain('is a dry run')
    expect(calls(r)).toEqual([])
  })

  it('refuses an appcast whose archive is anywhere but the update host', () => {
    const github = 'https://github.com/outof-place/pod/releases/download/v1.0.0-rc6'
    const r = setup({ feed: appcast('1000006', 'Pod-1.0.0-rc6.dmg', 18, github) })
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain(`enclosure is ${HOST}/Pod-<version>.dmg`)
    expect(calls(r)).toEqual([])
  })

  it('refuses a DMG that is not the length the appcast signed', () => {
    const r = setup({ feed: appcast('1000006', 'Pod-1.0.0-rc6.dmg', 5) })
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain('is not the 5 bytes the appcast says')
    expect(calls(r)).toEqual([])
  })

  it('refuses to publish the feed inside an agent', () => {
    const r = setup()
    expect(run(r, [r.release], { CLAUDECODE: '1' }).out).toContain('run this in your own Terminal')
    expect(calls(r)).toEqual([])
    expect(live(r)).toBe(OLD_FEED)
  })

  it('puts a rehearsal feed under rehearsal/<name>/ only, and takes it away again', () => {
    const r = setup()
    const dir = join(r.release, 'feed')
    mkdirSync(dir)
    writeFileSync(join(dir, 'appcast.xml'), 'rehearsal feed')
    writeFileSync(join(dir, 'Pod-0.0.101.dmg'), 'rehearsal archive')
    const base = `${HOST}/rehearsal/t1/`
    // Agents may: it touches neither the feed nor a published archive.
    const result = run(r, ['--rehearsal', dir, base], { CLAUDECODE: '1' })
    expect(result.status, result.out).toBe(0)
    expect(result.out).toContain(`${base}Pod-0.0.101.dmg`)
    expect(readdirSync(join(r.vercel, 'blob', 'rehearsal', 't1')).sort()).toEqual([
      'Pod-0.0.101.dmg',
      'appcast.xml'
    ])
    expect(calls(r).some((call) => /^(deploy|promote)/.test(call))).toBe(false)
    expect(live(r)).toBe(OLD_FEED)
    const removed = run(r, ['--remove-rehearsal', base], { CLAUDECODE: '1' })
    expect(removed.status, removed.out).toBe(0)
    expect(readdirSync(join(r.vercel, 'blob', 'rehearsal', 't1'))).toEqual([])
    expect(readFileSync(join(r.vercel, 'blob', 'Pod-1.0.0-rc5.dmg'), 'utf8')).toBe('rc5')
  })

  it('fails a rehearsal whose archive the host serves at another length', () => {
    const r = setup()
    const dir = join(r.release, 'feed')
    mkdirSync(dir)
    writeFileSync(join(dir, 'Pod-0.0.101.dmg'), 'rehearsal archive')
    const result = run(r, ['--rehearsal', dir, `${HOST}/rehearsal/t2/`], {
      CLAUDECODE: '1',
      FAKE_VERCEL_SHORT_PUT: '1'
    })
    expect(result.status).toBe(1)
    expect(result.out).toContain(`${HOST}/rehearsal/t2/Pod-0.0.101.dmg does not serve`)
  })

  it('refuses a rehearsal anywhere but rehearsal/<name>/', () => {
    const r = setup()
    const result = run(r, ['--rehearsal', r.release, `${HOST}/`], { CLAUDECODE: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('rehearsal/<name>/')
    expect(calls(r)).toEqual([])
  })
})

describe('the update host', () => {
  const coordinates = Object.fromEntries(
    readFileSync(join(product, 'update-host', 'update-host.sh'), 'utf8')
      .split('\n')
      .filter((line) => /^POD_[A-Z_]+=/.test(line))
      .map((line) => line.split('='))
  )
  const config = JSON.parse(readFileSync(join(product, 'update-host', 'vercel.json'), 'utf8'))

  it('keeps the feed every installed Pod since rc5 reads', () => {
    // A one-way door: an edit here strands every installed Pod on its version.
    expect(coordinates.POD_UPDATE_HOST).toBe('https://updates.pod.codes')
    expect(coordinates.POD_UPDATE_FEED).toBe('$POD_UPDATE_HOST/appcast.xml')
  })

  it('redirects the archives to the Blob store publish-update.sh uploads to, temporarily', () => {
    const archives = config.redirects.find((r: { source: string }) => r.source.includes('.dmg'))
    expect(archives).toEqual({
      source: '/:archive(Pod-[^/]+\\.dmg)',
      destination: `${coordinates.POD_UPDATE_BLOB_URL}/:archive`,
      // 307: where the archives live can move without a release.
      permanent: false
    })
    for (const redirect of config.redirects) {
      expect(redirect.destination.startsWith(`${coordinates.POD_UPDATE_BLOB_URL}/`)).toBe(true)
      expect(redirect.permanent).toBe(false)
    }
  })

  it('lets no CDN or browser keep an old appcast', () => {
    const appcastHeaders = config.headers.find(
      (h: { source: string }) => h.source === '/appcast.xml'
    )
    expect(appcastHeaders.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }
    ])
  })
})
