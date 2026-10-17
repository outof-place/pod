# Release runbook: RC1 → 1.0

What the release owner does by hand. Everything else is `product/release-one-app.sh`, which builds and checks but publishes nothing. Background: [RELEASING.md](./RELEASING.md).

## Versions

| Release | CFBundleShortVersionString | CFBundleVersion (Sparkle compares this) | Tag          | DMG                 |
| ------- | -------------------------- | --------------------------------------- | ------------ | ------------------- |
| RC 1    | `1.0.0-rc1`                | `1000001`                               | `v1.0.0-rc1` | `Pod-1.0.0-rc1.dmg` |
| RC 2    | `1.0.0-rc2`                | `1000002`                               | `v1.0.0-rc2` | `Pod-1.0.0-rc2.dmg` |
| RC 3    | `1.0.0-rc3`                | `1000003`                               | `v1.0.0-rc3` | `Pod-1.0.0-rc3.dmg` |
| RC 4    | `1.0.0-rc4`                | `1000004`                               | `v1.0.0-rc4` | `Pod-1.0.0-rc4.dmg` |
| RC 5    | `1.0.0-rc5`                | `1000005`                               | `v1.0.0-rc5` | `Pod-1.0.0-rc5.dmg` |
| 1.0     | `1.0.0`                    | `1000099`                               | `v1.0.0`     | `Pod-1.0.0.dmg`     |

Tags are `v<version>`, created by `gh release create --target <the commit>`. `release-one-app.sh` refuses a tag that already exists, in this clone or on GitHub. Orca's tags were deleted from GitHub on 2026-10-13, but a clone that fetched upstream still has Orca's `v1.0.1` to `v1.4.224`, and the guard then refuses Pod 1.0.1 and later. In the release clone, delete those local tags and stop them coming back: remove the upstream remote, or `git config remote.upstream.tagOpt --no-tags`.

`product/scripts/pod-build-number.sh <version>` gives the build number (MAJOR·1000000 + MINOR·10000 + PATCH·100 + rc number, 99 for the release). Test builds (`0.0.1-testN`) carry no feed, so they never update: install the first RC by hand from its DMG.

## Once: the Sparkle signing key (you, in Terminal; agents never run generate_keys or touch the key)

Sparkle 2.10.0 is the version PodNative embeds; use its own `generate_keys`:

```sh
mkdir -p ~/sparkle-2.10.0 && cd ~/sparkle-2.10.0
curl -fLO https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz
shasum -a 256 Sparkle-2.10.0.tar.xz   # must print c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
tar -xJf Sparkle-2.10.0.tar.xz bin
~/sparkle-2.10.0/bin/generate_keys --account codes.pod
```

- **What it does:** it makes an EdDSA key pair. The private key goes into your **login keychain** (item "Private key for signing Sparkle updates", account `codes.pod`; macOS may ask to allow the save). The public key is printed. Run again, it reuses the account's key and never overwrites it.
- **Where the public key goes:** the printed base64 string, alone on one line, into PodNative's `scripts/sparkle-ed-public-key.txt`. Send it to nt-lean, who commits it. `~/sparkle-2.10.0/bin/generate_keys --account codes.pod -p` prints it again. Every distribution build embeds it as `SUPublicEDKey`; without it, a build never updates and `release-one-app.sh` refuses to run.
- **Backup, offline:** `(umask 077; ~/sparkle-2.10.0/bin/generate_keys --account codes.pod -x /Volumes/<encrypted volume>/pod-sparkle-key)`, then `ls -l` must show `-rw-------`. The file is the private key itself: keep it on an encrypted external volume no sync tool watches, never in `~/Documents`, `~/Desktop`, iCloud Drive, Dropbox, a repo or a cloud folder. `-f <file>` imports it on a new release Mac. A lost key can only be replaced through a key rotation shipped as a Developer ID signed DMG, which is why every release's Sparkle archive is the signed DMG.

## Pod's update host

Every Pod since rc5 reads `https://updates.pod.codes/appcast.xml`, and every appcast names its DMG at `https://updates.pod.codes/Pod-<version>.dmg`. The name is ours (pod.codes, Vercel DNS), so installed apps keep finding their updates whatever serves it later. Nothing an installed Pod fetches for an update lives on GitHub. The coordinates are in `product/update-host/update-host.sh`.

- **What serves it:** the Vercel project `pod-updates` (team outofplace), with no Git connection, so no push and no website deploy can change it. Its files are `product/update-host/` (`vercel.json`, `robots.txt`) plus the release's `appcast.xml`, deployed by `publish-update.sh`. `/appcast.xml` is a file of the deployment (`Cache-Control: public, max-age=0, must-revalidate`; the CDN caches per deployment, so a promoted deployment answers within seconds). `/Pod-<version>.dmg` answers 307 to the same name in the public Blob store `pod-updates` (fra1), which Sparkle follows as it followed GitHub's redirects. A 307, not a 308: where the DMGs live can move with a deploy of `vercel.json`, without a release.
- **Public but unlisted:** feed and DMGs need no login (Sparkle's EdDSA signatures are the integrity check). There is no listing (`/` and unknown paths are 404, the Blob store's root answers 400), every response says `X-Robots-Tag: noindex`, and nothing on pod.codes links here.
- **Access:** the release owner runs `vercel login` with access to the outofplace team. The Blob store is reached over OIDC through the project's development environment (`vercel env pull` issues a 12-hour token); the project holds no long-lived Blob token.
- **Rehearsals** use `/rehearsal/<name>/` (307 to Blob `rehearsal/<name>/`): `publish-update.sh --rehearsal <dir> https://updates.pod.codes/rehearsal/<name>/` puts a feed there, `--remove-rehearsal` takes it away. PodNative's `scripts/update-rehearsal.sh` runs a real Sparkle update against it with `REHEARSAL_FEED_BASE` and `REHEARSAL_PUBLISH_SCRIPT`.
- **Cost:** within the outofplace Pro plan's $20 monthly credit. A 285 MB DMG to 30 installs is about 9 GB of Blob data transfer (fra1 $0.05/GB, plus $0.06/GB origin transfer on a CDN miss), each kept DMG about $0.01 a month of storage ($0.025/GB-month), each deployment one minute of build.

### GitHub's feed, for Pods up to rc4

Pods up to rc4 read `https://github.com/outof-place/pod/releases/download/appcast/appcast.xml`, the `appcast.xml` asset of the prerelease tagged `appcast`. rc5 is the bridge (`POD_BRIDGE_VERSION`): its appcast goes there too, with its DMG on updates.pod.codes, so an rc4 finds rc5 there and reads Pod's own host from then on. `publish-github-appcast.sh` refuses any other release: after rc5, nothing writes to GitHub's feed. When the repo turns private, that URL answers 404, and a Pod still on rc4 or older stops finding updates (see "Closing the repo").

## Each release

0. **Pre-flight, rc5:** release only from a main with both OrbStack fixes, the placeholder gate (`6e2cb3482d`, "the anthropic route always checks the placeholder") and the relay on 127.0.0.2 (lands as `ad0bb6e13b`, rebased from `pod/orbstack-relay-off-forward-v2`, not `e43de6640e`): `git merge-base --is-ancestor <sha> HEAD` for each. `assemble-one-app.sh` refuses a PodNative built with measurement seams, and PodNative's `release-app.sh` does the same; never route around either.
1. **The Electron zip, cached and checked**: `product/scripts/electron-cache.sh`. It checks the zip electron-builder unpacks (Electron's version from `pnpm-lock.yaml`) against the installed package's `checksums.json` and Electron's own `SHASUMS256.txt`, in `~/Library/Caches/electron/<sha256 of the release URL>/`. A missing or different one: `--from <zip>` copies a checked zip in (another Mac's cache, a download), `--fetch` downloads it. `release-one-app.sh` runs the check again before release.sh.
   - electron-builder 26.15.3 (@electron/get 3.1.0) reads neither `ELECTRON_CACHE` nor `electron_config_cache`; `ELECTRON_BUILDER_CACHE` moves only its own tools. No `ELECTRON_MIRROR`: it changes the cache directory.
   - The build still downloads `SHASUMS256.txt` from github.com (never cached), so GitHub must answer even with a full cache.
2. **Dry run first**, same chain, throwaway key:
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer PATH="$PWD/product/scripts/net-shims:$PATH" product/release-one-app.sh 1.0.0-rc1 --native-checkout <clean PodNative checkout at the pinned revision> --out ~/pod-releases/1.0.0-rc1-dry --dry-run`
   - `--out` must be outside the Pod checkout (electron-builder packs the checkout). `product/scripts/net-shims` retries codesign's timestamp, and notarytool and stapler on network errors (a dropped upload is sent again; stdout stays notarytool's own JSON). On a slow uplink one release takes 40 minutes and its GitHub upload another 30: create the release as a draft, `gh release upload` the assets, then publish it.
   - Release from clean clones outside your working checkouts (one for Pod, one for PodNative), so a build never packs or reads work in progress. PodNative needs Xcode 27 (`DEVELOPER_DIR`).
   - It ends with the feeds a release of this version publishes: updates.pod.codes, and for rc5 also GitHub's.
3. **The release**, on the release Mac, at low load, one build at a time:
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer PATH="$PWD/product/scripts/net-shims:$PATH" product/release-one-app.sh 1.0.0-rc1 --native-checkout <same checkout> --out ~/pod-releases/1.0.0-rc1`
   - release.sh also leaves `latest-mac.yml` in the checkout's `dist/`: never publish it, and move `dist/` out of the checkout afterwards.
   - Run it from Terminal, not from an agent's shell: the real path refuses `CLAUDECODE`.
   - macOS asks **twice** for access to "Private key for signing Sparkle updates": once for `generate_appcast`, then for `sign_update`, which checks the feed's signature. Choose **Allow** both times, not "Always Allow", which would let these tools read the key without asking from then on.
   - Notarization runs five times (runtime app and DMG, PodNative, the assembled app and its DMG).
4. **Check** `~/pod-releases/1.0.0-rc1/release/artifacts.txt`: version, build number, the commit, feed (`https://updates.pod.codes/appcast.xml`; rc5 also lists the GitHub bridge), public key, the assets and their sha256. The script has already checked the DMG's EdDSA signature against the app's own `SUPublicEDKey` with CryptoKit.
5. **Publish**, from Terminal with `gh auth status` green and `vercel whoami` in the outofplace team, with the commands the script prints, in this order:
   - the tag, notes and archive on GitHub: `gh release create v1.0.0-rc1 Pod-1.0.0-rc1.dmg Pod-1.0.0-rc1.zip SHA256SUMS --repo outof-place/pod --target <commit> --title "Pod 1.0.0-rc1" --notes-file product/release-notes/1.0.0-rc1.md --prerelease`. The notes are the version's `product/release-notes/<version>.md`, committed before the release. RC1's lists a known issue: quitting an app started directly from a Pod terminal can end all of Pod's terminal sessions about a minute later. Carry it into every release's notes until the fix ships. The commit must be pushed to outof-place/pod; without `--target` GitHub would tag the default branch's head. An RC is a prerelease; 1.0.0 is not. No installed Pod downloads from this release any more.
   - then the update host: `product/scripts/publish-update.sh ~/pod-releases/1.0.0-rc1/release`. It uploads the DMG to the Blob store once (a published DMG is never replaced: an app may be checking those bytes against the signature it read, so a wrong one means a new version), deploys the appcast as a production deployment that is not on the domain yet, downloads the appcast and the DMG through that deployment and compares them byte for byte, and only then promotes it to updates.pod.codes. It reads the domain until it serves the new appcast byte for byte; if it never does, it promotes the deployment the domain served before. Every failure says whether the feed changed. A re-run finds the DMG already there and checks it. It refuses a dry run's directory: an appcast signed with the throwaway key would lock installed Pods out of the feed for 20 days (below).
   - rc5 only, last: `product/scripts/publish-github-appcast.sh ~/pod-releases/1.0.0-rc5/release/appcast.xml`, which writes the same appcast to GitHub's feed for Pods up to rc4. It checks that updates.pod.codes already serves this appcast byte for byte. GitHub refuses a second asset with one name, and `gh release upload --clobber` deletes before it uploads, so the script uploads `appcast.xml.new` and downloads it back to compare, renames the live asset to `appcast.xml.old` and the new one to `appcast.xml` (the feed is missing only between those two API calls; a failed second rename puts the old one back), then reads the feed until it serves the new file byte for byte before it deletes `appcast.xml.old`; a feed that never shows up rolls the swap back. On any failure it says what state the release is in; never fix that with `--clobber`.
6. **Verify**:
   `curl -fsSL https://updates.pod.codes/appcast.xml | grep -E 'sparkle:(version|shortVersionString)|enclosure'` must show the new build and `https://updates.pod.codes/Pod-<version>.dmg`, and `curl -sSIL https://updates.pod.codes/Pod-<version>.dmg | grep -iE '^HTTP|content-length'` must end in 200 with the DMG's size. For rc5 also `curl -fsSL https://github.com/outof-place/pod/releases/download/appcast/appcast.xml | grep sparkle:version` (1000005). An installed earlier RC then finds the update from Pod's "Check for Updates…" menu item.
   - Not across a key change: an app with `SURequireSignedFeed` checks the feed only against its own `SUPublicEDKey`, and Sparkle 2.10.0 refuses another key's feed for 20 days from the first failure (`SUAppcastDriver.m`). rc2 rotated the key (rc1 `6Ru5s8…`, rc2 `rMnqNp…`, the old private key is gone), so rc1 installs rc2 by hand. `update-rehearsal.sh` uses one key for both builds and cannot catch this.
7. **Unregister the build's apps**: every `.app` a release leaves outside `/Applications` (the `dist/` moved out of the checkout, `~/pod-releases/<version>`, the dry run's directory, a hotfix build) carries Pod's bundle ids, so LaunchServices may open one of them instead of `/Applications/Pod.app` (on 17.10 a stale build ran next to the installed Pod). Find them with `fd -u -t d -e app --prune . ~/pod-releases` (`-u`: `dist/` is gitignored), run `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u <app>` on each, then move them to the Trash; keep the DMG, the zip and `release/`.

## Closing the repo

When outof-place/pod turns private, GitHub's feed and every GitHub release asset answer 404 to installed apps. Pods since rc5 read updates.pod.codes and are not affected. A Pod still on rc4 or older stops finding updates: Sparkle checks once a day by default, so close the repo only after rc5 has been on GitHub's feed for a while and the team's Pods show rc5 or later (Pod › About). A Pod left behind updates by hand: quit it, replace `/Applications/Pod.app` with the app from `https://updates.pod.codes/Pod-<latest>.dmg`, open it; Sparkle takes it from there.

Never: run `generate_keys` with another account or from an agent, an E2E or a fake `HOME`; import the key into any other keychain; publish a `--dry-run` directory (its artifacts.txt says DRY RUN, and its key was thrown away); replace or delete a published `Pod-<version>.dmg` in the Blob store; change `POD_UPDATE_FEED` or connect `pod-updates` to a Git repo; delete or re-tag the `appcast` release while the repo is public.
