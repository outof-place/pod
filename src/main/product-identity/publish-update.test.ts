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
const RELEASES = 'https://github.com/outof-place/pod-releases/releases/download'

// Vercel in a directory: blob/<pathname> is the store, served/<n>/ what deployment n serves (its
// files, and rehearsal/ of the store through the redirect), live the deployment on the domain.
// FAKE_VERCEL_STALE_PROMOTE=<n> promotes deployment n without the domain ever serving it,
// FAKE_VERCEL_PROMOTE_FAILS=1 refuses every promote, FAKE_VERCEL_PROMOTE_409=1 answers 409 for a
// deployment the domain then serves.
const FAKE_VERCEL = `#!/bin/bash
set -euo pipefail
s=$FAKE_VERCEL
echo "$*" >>"$s/calls.log"
oidc() {
  [ "\${VERCEL_OIDC_TOKEN:-}" = fake-oidc ] && [ "\${BLOB_STORE_ID:-}" = store_6oaqIaz38g6zR40k ] ||
    { echo "no Blob credentials" >&2; exit 1; }
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
    name=$(sed -n 's/.*--pathname \\([^ ]*\\).*/\\1/p' <<<"$*")
    if [ -e "$s/blob/$name" ] && [[ "$*" != *"--allow-overwrite true"* ]]; then
      echo "This blob already exists" >&2; exit 1
    fi
    mkdir -p "$(dirname "$s/blob/$name")"
    cp "$3" "$s/blob/$name" ;;
  "blob del")
    oidc
    rm -f "$s/blob/$3" ;;
  deploy*)
    n=$(cat "$s/next"); echo $((n + 1)) >"$s/next"
    cp -R "$2" "$s/deployments/$n"
    mkdir -p "$s/served/$n"
    cp "$s/deployments/$n/appcast.xml" "$s/deployments/$n/robots.txt" "$s/served/$n/"
    ln -sfn "$s/blob/rehearsal" "$s/served/$n/rehearsal"
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

// outof-place/pod-releases in a directory: releases/<tag>/<asset> (served as the download URL
// releases/<tag>/<asset>), .meta/<asset>.id and an optional .meta/<asset>.state (default
// "uploaded"), .prerelease for a prerelease, tags/<tag> for each tag. Like GitHub, it refuses a
// second asset of one name unless --clobber, and answers 404 for a missing release.
// FAKE_GH_FAIL_UPLOAD=1 fails every upload, FAKE_GH_SHORT_UPLOAD=1 stores each upload cut short.
const FAKE_GH = `#!/bin/bash
set -euo pipefail
s=$FAKE_GH
echo "$*" >>"$s/calls.log"
repo=outof-place/pod-releases
add() {
  [ "\${FAKE_GH_FAIL_UPLOAD:-0}" != 1 ] || { echo "HTTP 502: upload failed" >&2; exit 1; }
  local name=\${2##*/} id
  cp "$2" "$1/$name"
  [ "\${FAKE_GH_SHORT_UPLOAD:-0}" != 1 ] || printf 'cut' >"$1/$name"
  id=$(cat "$s/next-id"); echo $((id + 1)) >"$s/next-id"
  echo "$id" >"$1/.meta/$name.id"
}
[[ " $* " == *" --repo $repo "* || "$1" = api ]] || { echo "fake gh: not $repo: $*" >&2; exit 2; }
case "$1 $2" in
  "api -X")
    case "$4" in
      repos/$repo/releases/assets/*)
        for meta in "$s"/releases/*/.meta/*.id; do
          [ -f "$meta" ] && [ "$(cat "$meta")" = "\${4##*/}" ] || continue
          dir=\${meta%/.meta/*}; name=\${meta##*/}; name=\${name%.id}
          rm -f "$dir/$name" "$meta" "$dir/.meta/$name.state"
          exit 0
        done
        echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      repos/$repo/git/refs/tags/*)
        [ -f "$s/tags/\${4##*/}" ] || { echo "gh: Reference does not exist (HTTP 422)" >&2; exit 1; }
        rm -f "$s/tags/\${4##*/}" ;;
      *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
    esac ;;
  api*)
    dir=$s/releases/\${2##*/}
    [ -d "$dir" ] || { echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      name=\${f##*/}
      state=uploaded
      [ ! -f "$dir/.meta/$name.state" ] || state=$(cat "$dir/.meta/$name.state")
      echo "$(cat "$dir/.meta/$name.id") $name $(wc -c <"$f" | tr -d ' ') $state sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)"
    done ;;
  "release create")
    dir=$s/releases/$3
    [ ! -d "$dir" ] || { echo "a release with the same tag name already exists" >&2; exit 1; }
    mkdir -p "$dir/.meta"
    touch "$s/tags/$3"
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo | --title | --notes) shift 2 ;;
        --prerelease) touch "$dir/.prerelease"; shift ;;
        *) add "$dir" "$1"; shift ;;
      esac
    done ;;
  "release upload")
    dir=$s/releases/$3
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    if [ -f "$dir/\${4##*/}" ]; then
      [[ " $* " == *" --clobber "* ]] || { echo "asset under the same name already exists" >&2; exit 1; }
      rm -f "$dir/\${4##*/}"
    fi
    add "$dir" "$4" ;;
  "release delete")
    [ -d "$s/releases/$3" ] || { echo "release not found" >&2; exit 1; }
    rm -rf "$s/releases/$3"
    [[ " $* " != *" --cleanup-tag "* ]] || rm -f "$s/tags/$3" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`

const OLD_FEED = appcast('1000005', 'v1.0.0-rc5', 'Pod-1.0.0-rc5.dmg', 3)

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function appcast(
  build: string,
  tag: string,
  archive: string,
  length: number,
  prefix = `${RELEASES}/${tag}/`
): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n` +
    `<item><sparkle:version>${build}</sparkle:version>` +
    `<enclosure url="${prefix}${archive}" length="${length}" type="application/octet-stream"/></item>\n` +
    `</channel></rss>\n`
  )
}

type Run = { vercel: string; gh: string; shims: string; release: string; dmg: string; feed: string }

/** Vercel whose domain serves rc5's feed, pod-releases with rc5's DMG, and rc6's release directory. */
function setup(options: { dmg?: string; feed?: string; artifacts?: string } = {}): Run {
  root = mkdtempSync(join(tmpdir(), 'pod-publish-update-'))
  const vercel = join(root, 'vercel')
  const gh = join(root, 'gh')
  const shims = join(root, 'bin')
  for (const dir of ['vercel/blob/rehearsal', 'vercel/deployments/0', 'vercel/served/0']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  for (const dir of ['gh/releases/v1.0.0-rc5/.meta', 'gh/tags', 'bin', 'release']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(shims, 'vercel'), FAKE_VERCEL)
  writeFileSync(join(shims, 'gh'), FAKE_GH)
  // The script's own cleanup tool, so its work directory goes with the test.
  writeFileSync(join(shims, 'pod-tmp-rm'), '#!/bin/bash\nrm -rf -- "$@"\n')
  for (const tool of ['vercel', 'gh', 'pod-tmp-rm']) {
    chmodSync(join(shims, tool), 0o755)
  }
  writeFileSync(join(gh, 'releases', 'v1.0.0-rc5', 'Pod-1.0.0-rc5.dmg'), 'rc5')
  writeFileSync(join(gh, 'releases', 'v1.0.0-rc5', '.meta', 'Pod-1.0.0-rc5.dmg.id'), '7\n')
  writeFileSync(join(gh, 'tags', 'v1.0.0-rc5'), '')
  writeFileSync(join(gh, 'next-id'), '100\n')
  writeFileSync(join(vercel, 'deployments', '0', 'appcast.xml'), OLD_FEED)
  writeFileSync(join(vercel, 'deployments', '0', 'robots.txt'), '')
  writeFileSync(join(vercel, 'served', '0', 'appcast.xml'), OLD_FEED)
  symlinkSync(join(vercel, 'blob', 'rehearsal'), join(vercel, 'served', '0', 'rehearsal'))
  symlinkSync(join(vercel, 'served', '0'), join(vercel, 'live'))
  writeFileSync(join(vercel, 'live-id'), 'dpl_0\n')
  writeFileSync(join(vercel, 'next'), '1\n')
  const release = join(root, 'release')
  const dmg = options.dmg ?? 'the rc6 disk image'
  writeFileSync(join(release, 'Pod-1.0.0-rc6.dmg'), dmg)
  const feed = options.feed ?? appcast('1000006', 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', dmg.length)
  writeFileSync(join(release, 'appcast.xml'), feed)
  writeFileSync(
    join(release, 'artifacts.txt'),
    options.artifacts ?? 'Pod 1.0.0-rc6 (CFBundleVersion 1000006), tag v1.0.0-rc6 at abc\n'
  )
  return { vercel, gh, shims, release, dmg, feed }
}

/** An asset already on release <tag>, as an earlier run left it. */
function seedAsset(r: Run, tag: string, name: string, data: string, state?: string): void {
  const dir = join(r.gh, 'releases', tag)
  mkdirSync(join(dir, '.meta'), { recursive: true })
  writeFileSync(join(r.gh, 'tags', tag), '')
  writeFileSync(join(dir, name), data)
  writeFileSync(join(dir, '.meta', `${name}.id`), '42\n')
  if (state) {
    writeFileSync(join(dir, '.meta', `${name}.state`), `${state}\n`)
  }
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
      FAKE_GH: r.gh,
      POD_UPDATE_READ_HOST: `file://${r.vercel}/live`,
      POD_RELEASES_READ_DOWNLOAD: `file://${r.gh}/releases`,
      POD_PUBLISH_RETRY_SECONDS: '0',
      ...env
    }
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() }
}

function calls(dir: string): string[] {
  const log = join(dir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}

function live(r: Run): string {
  return readFileSync(join(r.vercel, 'live', 'appcast.xml'), 'utf8')
}

function asset(r: Run, tag: string, name: string): string {
  return readFileSync(join(r.gh, 'releases', tag, name), 'utf8')
}

describe('publish-update.sh', () => {
  it('creates the release with its DMG, checks the download, then puts the feed on the domain', () => {
    const r = setup()
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(result.out).toContain(`${HOST}/appcast.xml serves`)
    expect(result.out).toContain(`its archive ${RELEASES}/v1.0.0-rc6/Pod-1.0.0-rc6.dmg`)
    expect(result.out).toContain(`delivered ${r.dmg.length} bytes`)
    expect(live(r)).toBe(r.feed)
    expect(asset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg')).toBe(r.dmg)
    // An RC is a prerelease, as on outof-place/pod.
    expect(existsSync(join(r.gh, 'releases', 'v1.0.0-rc6', '.prerelease'))).toBe(true)
    const [lookup, create, ...ghRest] = calls(r.gh)
    expect(lookup).toMatch(/^api repos\/outof-place\/pod-releases\/releases\/tags\/v1\.0\.0-rc6 /)
    expect(create).toMatch(/^release create v1\.0\.0-rc6 \S+\/Pod-1\.0\.0-rc6\.dmg --repo /)
    expect(ghRest).toEqual([])
    expect(readdirSync(join(r.vercel, 'deployments', '1')).sort()).toEqual([
      'appcast.xml',
      'robots.txt',
      'vercel.json'
    ])
    // No Blob in a release: the DMG lives on GitHub only.
    const [deploy, inspect, promote, ...rest] = calls(r.vercel)
    expect(deploy).toMatch(
      /^deploy \S+ --prod --skip-domain --project prj_\w+ --yes --json --scope outofplace$/
    )
    expect(inspect).toBe('inspect updates.pod.codes --json --scope outofplace')
    expect(promote).toMatch(/^promote file:\/\/\S+\/served\/1 --yes --scope outofplace$/)
    expect(rest).toEqual([])
  })

  it('makes a final release no prerelease', () => {
    const dmg = 'the 1.0.0 disk image'
    const r = setup({ dmg, feed: appcast('1000099', 'v1.0.0', 'Pod-1.0.0.dmg', dmg.length) })
    rmSync(join(r.release, 'Pod-1.0.0-rc6.dmg'))
    writeFileSync(join(r.release, 'Pod-1.0.0.dmg'), dmg)
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(asset(r, 'v1.0.0', 'Pod-1.0.0.dmg')).toBe(dmg)
    expect(existsSync(join(r.gh, 'releases', 'v1.0.0', '.prerelease'))).toBe(false)
  })

  it('uploads the DMG to a release that already exists without it', () => {
    const r = setup()
    mkdirSync(join(r.gh, 'releases', 'v1.0.0-rc6', '.meta'), { recursive: true })
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(calls(r.gh)).toContain(
      `release upload v1.0.0-rc6 ${join(r.release, 'Pod-1.0.0-rc6.dmg')} --repo outof-place/pod-releases`
    )
    expect(asset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg')).toBe(r.dmg)
    expect(live(r)).toBe(r.feed)
  })

  it('finds the DMG of an earlier run on its release and uploads nothing', () => {
    const r = setup()
    seedAsset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', 'the rc6 disk image')
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(calls(r.gh).some((call) => /^release (create|upload)/.test(call))).toBe(false)
    expect(live(r)).toBe(r.feed)
  })

  it('never replaces a published DMG, even one of the same size', () => {
    const r = setup()
    const other = 'x'.repeat(r.dmg.length)
    seedAsset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', other)
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain('a published archive is never replaced')
    expect(asset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg')).toBe(other)
    expect(calls(r.vercel)).toEqual([])
    expect(live(r)).toBe(OLD_FEED)
  })

  it('deletes an upload that never finished and uploads the DMG again', () => {
    const r = setup()
    seedAsset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', 'the rc6', 'open')
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(calls(r.gh)).toContain('api -X DELETE repos/outof-place/pod-releases/releases/assets/42')
    expect(asset(r, 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg')).toBe(r.dmg)
    expect(live(r)).toBe(r.feed)
  })

  it('leaves the feed alone when the upload fails', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_GH_FAIL_UPLOAD: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the feed is unchanged')
    expect(calls(r.vercel)).toEqual([])
    expect(live(r)).toBe(OLD_FEED)
  })

  it('leaves the feed alone when the enclosure URL does not deliver the DMG byte for byte', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_GH_SHORT_UPLOAD: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain(
      `${RELEASES}/v1.0.0-rc6/Pod-1.0.0-rc6.dmg does not deliver Pod-1.0.0-rc6.dmg byte for byte`
    )
    expect(result.out).toContain('the feed is unchanged')
    expect(calls(r.vercel)).toEqual([])
    expect(live(r)).toBe(OLD_FEED)
  })

  it('puts the domain back on its previous deployment when it never serves the new feed', () => {
    const r = setup()
    const result = run(r, [r.release], { FAKE_VERCEL_STALE_PROMOTE: '1' })
    expect(result.status).toBe(1)
    expect(result.out).toContain('the domain is back on dpl_0')
    expect(calls(r.vercel)).toContain('promote dpl_0 --yes --scope outofplace')
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
    expect(calls(r.vercel)).toEqual([])
    expect(calls(r.gh)).toEqual([])
  })

  it.each([
    ['the update host, which serves no DMG', `${HOST}/`],
    [
      'outof-place/pod, which goes private',
      'https://github.com/outof-place/pod/releases/download/v1.0.0-rc6/'
    ],
    ['another version tag', `${RELEASES}/v1.0.0-rc5/`]
  ])('refuses an appcast whose archive is on %s', (_where, prefix) => {
    const r = setup({ feed: appcast('1000006', 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', 18, prefix) })
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain(`enclosure is ${RELEASES}/v<version>/Pod-<version>.dmg`)
    expect(calls(r.vercel)).toEqual([])
    expect(calls(r.gh)).toEqual([])
  })

  it('refuses a DMG that is not the length the appcast signed', () => {
    const r = setup({ feed: appcast('1000006', 'v1.0.0-rc6', 'Pod-1.0.0-rc6.dmg', 5) })
    const result = run(r, [r.release])
    expect(result.status).toBe(1)
    expect(result.out).toContain('is not the 5 bytes the appcast says')
    expect(calls(r.gh)).toEqual([])
  })

  it('refuses to publish the feed inside an agent', () => {
    const r = setup()
    expect(run(r, [r.release], { CLAUDECODE: '1' }).out).toContain('run this in your own Terminal')
    expect(calls(r.vercel)).toEqual([])
    expect(calls(r.gh)).toEqual([])
    expect(live(r)).toBe(OLD_FEED)
  })

  it('removes its work directory, the downloaded DMG with it, on a Mac without pod-tmp-rm', () => {
    const r = setup()
    rmSync(join(r.shims, 'pod-tmp-rm'))
    const leftovers = (): string[] =>
      readdirSync('/tmp').filter((name) => name.startsWith('pod-publish-update.'))
    const before = leftovers()
    const result = run(r, [r.release])
    expect(result.status, result.out).toBe(0)
    expect(leftovers().filter((name) => !before.includes(name))).toEqual([])
  })

  describe('a rehearsal', () => {
    const base = `${HOST}/rehearsal/t1/`
    const downloads = `${RELEASES}/rehearsal-t1/`

    function rehearsalFeed(r: Run, prefix = downloads): string {
      const dir = join(r.release, 'feed')
      mkdirSync(dir)
      writeFileSync(join(dir, 'Pod-0.0.101.dmg'), 'rehearsal archive')
      writeFileSync(
        join(dir, 'appcast.xml'),
        appcast('101', 'unused', 'Pod-0.0.101.dmg', 17, prefix)
      )
      return dir
    }

    it('names its own prerelease for its downloads, never a version tag', () => {
      const r = setup()
      const result = run(r, ['--rehearsal-downloads', base], { CLAUDECODE: '1' })
      expect(result).toEqual({ status: 0, out: downloads })
    })

    it('puts its archive on its own prerelease and its feed under rehearsal/<name>/, then takes both away', () => {
      const r = setup()
      const dir = rehearsalFeed(r)
      // Agents may: it touches neither the feed nor a published archive.
      const result = run(r, ['--rehearsal', dir, base], { CLAUDECODE: '1' })
      expect(result.status, result.out).toBe(0)
      expect(result.out).toContain(`${HOST}/rehearsal/t1/appcast.xml`)
      expect(asset(r, 'rehearsal-t1', 'Pod-0.0.101.dmg')).toBe('rehearsal archive')
      expect(existsSync(join(r.gh, 'releases', 'rehearsal-t1', '.prerelease'))).toBe(true)
      expect(readdirSync(join(r.vercel, 'blob', 'rehearsal', 't1'))).toEqual(['appcast.xml'])
      expect(calls(r.vercel).some((call) => /^(deploy|promote)/.test(call))).toBe(false)
      expect(live(r)).toBe(OLD_FEED)

      const removed = run(r, ['--remove-rehearsal', base], { CLAUDECODE: '1' })
      expect(removed.status, removed.out).toBe(0)
      expect(existsSync(join(r.gh, 'releases', 'rehearsal-t1'))).toBe(false)
      expect(existsSync(join(r.gh, 'tags', 'rehearsal-t1'))).toBe(false)
      expect(readdirSync(join(r.vercel, 'blob', 'rehearsal', 't1'))).toEqual([])
      expect(asset(r, 'v1.0.0-rc5', 'Pod-1.0.0-rc5.dmg')).toBe('rc5')
      expect(existsSync(join(r.gh, 'tags', 'v1.0.0-rc5'))).toBe(true)
    })

    it('replaces the archive an earlier run of its series left', () => {
      const r = setup()
      const dir = rehearsalFeed(r)
      seedAsset(r, 'rehearsal-t1', 'Pod-0.0.101.dmg', 'an earlier build')
      const result = run(r, ['--rehearsal', dir, base], { CLAUDECODE: '1' })
      expect(result.status, result.out).toBe(0)
      expect(asset(r, 'rehearsal-t1', 'Pod-0.0.101.dmg')).toBe('rehearsal archive')
    })

    it('fails before its feed is up when its archive does not arrive byte for byte', () => {
      const r = setup()
      const dir = rehearsalFeed(r)
      const result = run(r, ['--rehearsal', dir, base], {
        CLAUDECODE: '1',
        FAKE_GH_SHORT_UPLOAD: '1'
      })
      expect(result.status).toBe(1)
      expect(result.out).toContain(`${downloads}Pod-0.0.101.dmg does not deliver`)
      expect(existsSync(join(r.vercel, 'blob', 'rehearsal', 't1'))).toBe(false)
    })

    it('refuses an appcast that names its archive anywhere but its own prerelease', () => {
      const r = setup()
      const dir = rehearsalFeed(r, base)
      const result = run(r, ['--rehearsal', dir, base], { CLAUDECODE: '1' })
      expect(result.status).toBe(1)
      expect(result.out).toContain('(--rehearsal-downloads)')
      expect(calls(r.gh)).toEqual([])
      expect(existsSync(join(r.vercel, 'blob', 'rehearsal', 't1'))).toBe(false)
    })

    it('goes nowhere but rehearsal/<name>/', () => {
      const r = setup()
      const result = run(r, ['--rehearsal', r.release, `${HOST}/`], { CLAUDECODE: '1' })
      expect(result.status).toBe(1)
      expect(result.out).toContain('rehearsal/<name>/')
      expect(calls(r.vercel)).toEqual([])
      expect(calls(r.gh)).toEqual([])
    })
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

  it('serves no DMG: it redirects rehearsal feeds alone, to the Blob store, temporarily', () => {
    expect(config.redirects).toEqual([
      {
        source: '/rehearsal/:path*',
        destination: `${coordinates.POD_UPDATE_BLOB_URL}/rehearsal/:path*`,
        // 307: where rehearsal feeds live can move without a release.
        permanent: false
      }
    ])
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
