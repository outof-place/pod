# Release runbook: RC1 → 1.0

What the release owner does by hand. Everything else is `product/release-one-app.sh`, which builds and checks but publishes nothing. Background: [RELEASING.md](./RELEASING.md).

## Versions

| Release | CFBundleShortVersionString | CFBundleVersion (Sparkle compares this) | Tag          | DMG                 |
| ------- | -------------------------- | --------------------------------------- | ------------ | ------------------- |
| RC 1    | `1.0.0-rc1`                | `1000001`                               | `v1.0.0-rc1` | `Pod-1.0.0-rc1.dmg` |
| RC 2    | `1.0.0-rc2`                | `1000002`                               | `v1.0.0-rc2` | `Pod-1.0.0-rc2.dmg` |
| 1.0     | `1.0.0`                    | `1000099`                               | `v1.0.0`     | `Pod-1.0.0.dmg`     |

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
- **Backup, offline:** `~/sparkle-2.10.0/bin/generate_keys --account codes.pod -x /Volumes/<USB or encrypted volume>/pod-sparkle-key`. The file is the private key itself, so keep it off this Mac and out of any repo or cloud folder. `-f <file>` imports it on a new release Mac. A lost key can only be replaced through a key rotation shipped as a Developer ID–signed DMG, which is why every release's Sparkle archive is the signed DMG.

## Once: the feed release

The app reads `https://github.com/outof-place/pod/releases/download/appcast/appcast.xml`: the `appcast.xml` asset of a dedicated release tagged `appcast`. It is a **prerelease**, so it never becomes GitHub's "latest" (the most recent release that is neither a prerelease nor a draft). With the feed outside `releases/latest`, RCs can be prereleases too. At the first release only:

```sh
gh release create appcast --repo outof-place/pod --prerelease --title "Pod update feed" \
  --notes "Sparkle's appcast for Pod. Replaced on every release; nothing to download here."
```

## Each release

1. **Dry run first**, same chain, throwaway key:
   `product/release-one-app.sh 1.0.0-rc1 --native-checkout <clean PodNative checkout at the pinned revision> --dry-run`
2. **The release**, on the release Mac, at low load, one build at a time:
   `product/release-one-app.sh 1.0.0-rc1 --native-checkout <same checkout>`
   - macOS asks once for access to "Private key for signing Sparkle updates": choose **Allow** (the tools run from a fresh temp directory each time, so "Always Allow" doesn't stick).
   - Notarization runs five times (runtime app and DMG, PodNative, the assembled app and its DMG).
3. **Check** `dist/release-1.0.0-rc1/artifacts.txt`: version, build number, feed, public key, the assets and their sha256.
4. **Publish**, from Terminal with `gh auth status` green, with the two commands the script prints, in this order:
   - the release: `gh release create v1.0.0-rc1 Pod-1.0.0-rc1.dmg Pod-1.0.0-rc1.zip SHA256SUMS --repo outof-place/pod --title "Pod 1.0.0-rc1" --notes-file notes.md --prerelease`. An RC is a prerelease; 1.0.0 is not, so it becomes "latest" for the website and the cask.
   - then the feed: `gh release upload appcast appcast.xml --repo outof-place/pod --clobber`. `--clobber` deletes the old asset and uploads the new one (GitHub refuses a second asset with the same name). The download URL is addressed by tag and file name, so it stays the same. Between the delete and the upload the URL answers 404; an app that checks right then tries again at its next check. The release goes first because the feed points at its DMG.
5. **Verify**:
   `curl -fsL https://github.com/outof-place/pod/releases/download/appcast/appcast.xml | grep -E 'sparkle:(version|shortVersionString)'`
   This must show the new build. An installed earlier RC then finds the update from Pod's "Check for Updates…" menu item.
6. **Homebrew** (outof-place/homebrew-tap), 1.0.0 and later only: `version`, `sha256` from `SHA256SUMS`, and `url` ending in `Pod-#{version}.dmg`.

Never: run `generate_keys` with another account or from an agent, an E2E or a fake `HOME`; import the key into any other keychain; publish a `--dry-run` directory (its artifacts.txt says DRY RUN, and its key was thrown away); delete or re-tag the `appcast` release.
