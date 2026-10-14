# Release runbook: RC1 → 1.0

What the release owner does by hand. Everything else is `product/release-one-app.sh`, which builds and checks but publishes nothing. Background: [RELEASING.md](./RELEASING.md).

## Versions

| Release | CFBundleShortVersionString | CFBundleVersion (Sparkle compares this) | Tag          | DMG                 |
| ------- | -------------------------- | --------------------------------------- | ------------ | ------------------- |
| RC 1    | `1.0.0-rc1`                | `1000001`                               | `v1.0.0-rc1` | `Pod-1.0.0-rc1.dmg` |
| RC 2    | `1.0.0-rc2`                | `1000002`                               | `v1.0.0-rc2` | `Pod-1.0.0-rc2.dmg` |
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
- **Backup, offline:** `(umask 077; ~/sparkle-2.10.0/bin/generate_keys --account codes.pod -x /Volumes/<encrypted volume>/pod-sparkle-key)`, then `ls -l` must show `-rw-------`. The file is the private key itself: keep it on an encrypted external volume no sync tool watches, never in `~/Documents`, `~/Desktop`, iCloud Drive, Dropbox, a repo or a cloud folder. `-f <file>` imports it on a new release Mac. A lost key can only be replaced through a key rotation shipped as a Developer ID–signed DMG, which is why every release's Sparkle archive is the signed DMG.

## Once: the feed release

The app reads `https://github.com/outof-place/pod/releases/download/appcast/appcast.xml`: the `appcast.xml` asset of a dedicated release tagged `appcast`. It is a **prerelease**, so it never becomes GitHub's "latest" (the most recent release that is neither a prerelease nor a draft). With the feed outside `releases/latest`, RCs can be prereleases too. At the first release only:

```sh
gh release create appcast --repo outof-place/pod --prerelease --title "Pod update feed" \
  --notes "Sparkle's appcast for Pod. Replaced on every release; nothing to download here."
```

## Each release

0. **The Electron zip, cached and checked**: `product/scripts/electron-cache.sh`. It checks the zip electron-builder unpacks (Electron's version from `pnpm-lock.yaml`) against the installed package's `checksums.json` and Electron's own `SHASUMS256.txt`, in `~/Library/Caches/electron/<sha256 of the release URL>/`. A missing or different one: `--from <zip>` copies a checked zip in (another Mac's cache, a download), `--fetch` downloads it. `release-one-app.sh` runs the check again before release.sh.
   - electron-builder 26.15.3 (@electron/get 3.1.0) reads neither `ELECTRON_CACHE` nor `electron_config_cache`; `ELECTRON_BUILDER_CACHE` moves only its own tools. No `ELECTRON_MIRROR`: it changes the cache directory.
   - The build still downloads `SHASUMS256.txt` from github.com (never cached), so GitHub must answer even with a full cache.
1. **Dry run first**, same chain, throwaway key:
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer PATH="$PWD/product/scripts/net-shims:$PATH" product/release-one-app.sh 1.0.0-rc1 --native-checkout <clean PodNative checkout at the pinned revision> --out ~/pod-releases/1.0.0-rc1-dry --dry-run`
   - `--out` must be outside the Pod checkout (electron-builder packs the checkout). `product/scripts/net-shims` retries codesign's timestamp, and notarytool and stapler on network errors (a dropped upload is sent again; stdout stays notarytool's own JSON). On a slow uplink one release takes 40 minutes and its GitHub upload another 30: create the release as a draft, `gh release upload` the assets, then publish it.
   - Release from clean clones outside your working checkouts (one for Pod, one for PodNative), so a build never packs or reads work in progress. PodNative needs Xcode 27 (`DEVELOPER_DIR`).
2. **The release**, on the release Mac, at low load, one build at a time:
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer PATH="$PWD/product/scripts/net-shims:$PATH" product/release-one-app.sh 1.0.0-rc1 --native-checkout <same checkout> --out ~/pod-releases/1.0.0-rc1`
   - release.sh also leaves `latest-mac.yml` in the checkout's `dist/`: never publish it, and move `dist/` out of the checkout afterwards.
   - Run it from Terminal, not from an agent's shell: the real path refuses `CLAUDECODE`.
   - macOS asks **twice** for access to "Private key for signing Sparkle updates": once for `generate_appcast`, then for `sign_update`, which checks the feed's signature. Choose **Allow** both times, not "Always Allow", which would let these tools read the key without asking from then on.
   - Notarization runs five times (runtime app and DMG, PodNative, the assembled app and its DMG).
3. **Check** `~/pod-releases/1.0.0-rc1/release/artifacts.txt`: version, build number, the commit, feed, public key, the assets and their sha256. The script has already checked the DMG's EdDSA signature against the app's own `SUPublicEDKey` with CryptoKit.
4. **Publish**, from Terminal with `gh auth status` green, with the two commands the script prints, in this order:
   - the release: `gh release create v1.0.0-rc1 Pod-1.0.0-rc1.dmg Pod-1.0.0-rc1.zip SHA256SUMS --repo outof-place/pod --target <commit> --title "Pod 1.0.0-rc1" --notes-file product/release-notes/1.0.0-rc1.md --prerelease`. The notes are the version's `product/release-notes/<version>.md`, committed before the release. RC1's lists a known issue: quitting an app started directly from a Pod terminal can end all of Pod's terminal sessions about a minute later. Carry it into every release's notes until the fix ships. The release that brings pod-decouple (ORCA_ env names become POD_) adds a known issue of its own: in a terminal opened before the update, the status of agents other than Claude whose hooks are JS or Python plugins (amp, opencode, pi, hermes) comes back only after the terminal is reopened. Carry it until the release after the decouple, when the legacy-name fallbacks go (after 2026-12-31). The fallbacks take ORCA_ names only in a Pod terminal: the hooks when its endpoint lies in the data folder of the Pod that installed them, `podx` when its user data lies in `~/Library/Application Support/Pod`, both compared with symlinks resolved. In a terminal of Orca.app, Pod's Claude hooks send Orca nothing and `podx` stops with "no Pod runtime in env"; the terminals of a dev or E2E Pod get no fallback either. The commit must be pushed to outof-place/pod; without `--target` GitHub would tag the default branch's head. An RC is a prerelease; 1.0.0 is not, so it becomes "latest" for the website and the cask.
   - then the feed: `product/scripts/publish-appcast.sh ~/pod-releases/1.0.0-rc1/release/appcast.xml`. GitHub refuses a second asset with one name, and `gh release upload --clobber` deletes before it uploads, so a failed upload would leave the feed at 404. The script uploads `appcast.xml.new` and downloads it back to compare. It then renames the live asset to `appcast.xml.old` and the new one to `appcast.xml`; the feed is missing only between those two API calls. If the second rename fails, it puts the old one back. Last, it reads the feed until it serves the new file byte for byte, and only then deletes `appcast.xml.old`; a feed that never shows up rolls the swap back. On any failure it says what state the release is in; never fix that with `--clobber`. The release goes first because the feed points at its DMG.
5. **Verify**:
   `curl -fsL https://github.com/outof-place/pod/releases/download/appcast/appcast.xml | grep -E 'sparkle:(version|shortVersionString)'`
   This must show the new build. An installed earlier RC then finds the update from Pod's "Check for Updates…" menu item.
   - Not across a key change: an app with `SURequireSignedFeed` checks the feed only against its own `SUPublicEDKey`, and Sparkle 2.10.0 refuses another key's feed for 20 days from the first failure (`SUAppcastDriver.m`). rc2 rotated the key (rc1 `6Ru5s8…`, rc2 `rMnqNp…`, the old private key is gone), so rc1 installs rc2 by hand. `update-rehearsal.sh` uses one key for both builds and cannot catch this.
6. **Homebrew** (outof-place/homebrew-tap), 1.0.0 and later only: `version`, `sha256` from `SHA256SUMS`, and `url` ending in `Pod-#{version}.dmg`.

Never: run `generate_keys` with another account or from an agent, an E2E or a fake `HOME`; import the key into any other keychain; publish a `--dry-run` directory (its artifacts.txt says DRY RUN, and its key was thrown away); delete or re-tag the `appcast` release.
