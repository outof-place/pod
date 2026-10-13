# Release runbook: RC1 → 1.0

What the release owner does by hand. Everything else is `product/release-one-app.sh`, which builds and checks but publishes nothing. Background: [RELEASING.md](./RELEASING.md).

## Versions

| Release | CFBundleShortVersionString | CFBundleVersion (Sparkle compares this) | Tag          | DMG                 |
| ------- | -------------------------- | --------------------------------------- | ------------ | ------------------- |
| RC 1    | `1.0.0-rc1`                | `1000001`                               | `v1.0.0-rc1` | `Pod-1.0.0-rc1.dmg` |
| RC 2    | `1.0.0-rc2`                | `1000002`                               | `v1.0.0-rc2` | `Pod-1.0.0-rc2.dmg` |
| 1.0     | `1.0.0`                    | `1000099`                               | `v1.0.0`     | `Pod-1.0.0.dmg`     |

`product/scripts/pod-build-number.sh <version>` gives the build number (MAJOR·1000000 + MINOR·10000 + PATCH·100 + rc number, 99 for the release). Test builds (`0.0.1-testN`) carry no feed, so they never update: install the first RC by hand from its DMG.

## Once: the Sparkle signing key (you run this, in Terminal, never through an agent)

```sh
mkdir -p ~/sparkle-2.10.0 && cd ~/sparkle-2.10.0
curl -fLO https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz
shasum -a 256 Sparkle-2.10.0.tar.xz   # must be c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
tar -xJf Sparkle-2.10.0.tar.xz bin
./bin/generate_keys --account codes.pod
```

- `generate_keys` makes the EdDSA key pair, keeps the private key in your **login keychain** (item "Private key for signing Sparkle updates", account `codes.pod`) and prints the public key. If the account already has a key, it reuses it and never overwrites it.
- **Back it up now:** `./bin/generate_keys --account codes.pod -x ~/Desktop/pod-sparkle-key`. The file is the private key itself. Move it into your password manager or an encrypted volume, then delete the file. If the key is lost, an update can only come as a Developer ID–signed DMG during a key rotation, which is why every release ships a signed DMG.
- **Public key into PodNative:** `./bin/generate_keys --account codes.pod -p` prints it. It goes, alone, into PodNative's `scripts/sparkle-ed-public-key.txt` (a PodNative commit). Every distribution build embeds it as `SUPublicEDKey`; without it, a build never updates and `release-one-app.sh` refuses to run.

## Each release

1. **Dry run first**, same chain, throwaway key:
   `product/release-one-app.sh 1.0.0-rc1 --native-checkout <clean PodNative checkout at the pinned revision> --dry-run`
2. **The release**, on the release Mac, at low load, one build at a time:
   `product/release-one-app.sh 1.0.0-rc1 --native-checkout <same checkout>`
   - macOS asks once for access to "Private key for signing Sparkle updates": choose **Allow** (the tools run from a fresh temp directory each time, so "Always Allow" doesn't stick).
   - Notarization runs five times (runtime app and DMG, PodNative, the assembled app and its DMG).
3. **Check** `dist/release-1.0.0-rc1/artifacts.txt`: version, build number, feed, public key, the four assets and their sha256.
4. **Publish** with the command the script prints, from Terminal with `gh auth status` green:
   `gh release create v1.0.0-rc1 Pod-1.0.0-rc1.dmg Pod-1.0.0-rc1.zip appcast.xml SHA256SUMS --repo outof-place/pod --title "Pod 1.0.0-rc1" --notes-file notes.md`
   - **Not `--prerelease` and not `--draft`.** The app reads `releases/latest/download/appcast.xml`, and GitHub's "latest" skips prereleases and drafts. An RC published as a prerelease would never reach installed RCs. Put "RC" in the title instead.
5. **Verify**:
   `curl -fsL https://github.com/outof-place/pod/releases/latest/download/appcast.xml | grep -E 'sparkle:(version|shortVersionString)'`
   This must show the new build. An installed earlier RC then finds the update from Pod's "Check for Updates…" menu item.
6. **Homebrew** (outof-place/homebrew-tap): `version`, `sha256` from `SHA256SUMS`, and `url` ending in `Pod-#{version}.dmg`.

Never: run `generate_keys` with another account or from an agent, an E2E or a fake `HOME`; import the key into any other keychain; publish a `--dry-run` directory (its artifacts.txt says DRY RUN, and its key was thrown away).
