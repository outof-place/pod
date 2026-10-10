# Releasing the product (Developer ID, notarization, GitHub Releases)

A release is an arm64 DMG and zip of `<displayName>.app`. Both are signed with a **Developer ID Application** certificate, notarized by Apple and stapled. They are published as a GitHub release in `identity.updateFeed`'s repo, together with `latest-mac.yml`, which the in-app updater reads.

For now, releases are cut **locally** with `product/release.sh` on the Mac that holds the signing key. `.github/workflows/pod-release.yml` runs the same script on a `v<semver>` tag, but needs its own certificate first (see [CI](#ci-later)).

## Signing setup (done)

| What                    | Value                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Signing identity        | `Developer ID Application: OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)`, `release.sh`'s default     |
| Certificate SHA-1       | `1DDF17FA620DE903DB70A05871EA26FD3F62C9EE`                                                       |
| Private key             | Login keychain of the release Mac, **not exportable**                                            |
| Notary credentials      | notarytool keychain profile `pod-notary`, `release.sh`'s default                                 |
| Alternative credentials | App Store Connect API key `KX7Q6Y844C` (`~/.appstoreconnect/private_keys/AuthKey_KX7Q6Y844C.p8`) |

Check both before a release:

```sh
security find-identity -v -p codesigning | grep "Developer ID Application"
xcrun notarytool history --keychain-profile pod-notary
```

To recreate the notary profile, run `xcrun notarytool store-credentials pod-notary` with either `--apple-id <email> --team-id 75Y2KR6P5W --password <app-specific password>` or `--key <.p8> --key-id <KEYID> --issuer <issuer uuid>`.

The first signature after a keychain change can raise a keychain prompt for the key. `release.sh` makes a test signature before it builds anything. If the test signature waits more than 60 s, the script stops and asks you to allow access (**Always Allow**), so a release never hangs halfway.

## Cutting a release

Versions are Pod's own semver, starting at `0.1.0`, and every release must be higher than the last. The Orca base is recorded in `upstream.json` and shown in the About panel; it is not part of the version. A prerelease such as `0.2.0-beta.1` is only offered to users who are already on a prerelease.

```sh
product/release.sh 0.1.0             # build, sign, notarize, staple, verify; no upload
product/release.sh 0.1.0 --publish   # the same, then the GitHub release v0.1.0
```

Set `POD_SIGN_IDENTITY`, or `NOTARY_PROFILE` / `APPLE_API_KEY` (+`_ID`, `_ISSUER`) / `APPLE_ID` (+`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), only to override the defaults above.

`release.sh` does the following:

1. Checks that the identity is a Developer ID in the keychain, then makes a test signature (keychain access and Apple's timestamp server).
2. Builds the JS, mobile web bundle and native helpers. The helpers get the product's identifiers: `<appId>.computer-use` and the notification helper's `--bundle-id`.
3. Fetches the claude-acc payload pinned in `config/claude-acc-payload.json` into `resources/claude-acc`, when the stack has that script. This also runs with `--skip-build`.
4. Runs electron-builder with `product/electron-builder.pod.cjs` (`POD_RELEASE=1`, `ORCA_MAC_RELEASE=1`). Before any signing, `afterPack` fails the build when app.asar is over 400 MB or packs a `dist`, `dist-*`, `test-results`, `playwright-report` or hidden folder (`product/release-bundle-gate.cjs`). Then it signs every nested binary with hardened runtime and a timestamp, notarizes and staples the app. When Apple's timestamp service fails mid-signing, the step reruns: at most 3 attempts, 3 min apart, and only for that failure.
5. Fails when the DMG is over 350 MB, then submits it with `notarytool submit --wait` and staples it.
6. Re-hashes `latest-mac.yml`, since stapling changed the DMG.
7. Gates on Gatekeeper:
   - `codesign --verify --deep --strict` passes, and the team is `75Y2KR6P5W`;
   - `stapler validate` passes for the app and the DMG;
   - `spctl -a -vv` on the app reports `source=Notarized Developer ID`;
   - `spctl -a -vv -t open` accepts the DMG.
   - Info.plist declares `ClaudeAccHost` (userData, cli), and claude-acc's `orcahost.py` resolves the app as Pod when the payload is bundled (`product/scripts/verify-claude-acc-host.mjs`).
8. With `--publish` only: uploads the DMG, zip, zip blockmap and `latest-mac.yml` with `gh release create`.

## CI (later)

The Developer ID key cannot leave the release Mac, so the workflow needs a **second** Developer ID Application certificate, created for CI by the account holder:

- **Xcode:** Settings → Accounts → team → Manage Certificates → **+** → Developer ID Application.
- **Web:** at <https://developer.apple.com/account/resources/certificates/add>, upload a CSR.

Export that certificate with its key as a `.p12`, then add these secrets under Settings → Secrets and variables → Actions:

| Secret                                                            | Value                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`                                                        | `base64 -i ci-cert.p12`                                                                                     |
| `CSC_KEY_PASSWORD`                                                | The password set on that `.p12`                                                                             |
| `POD_SIGN_IDENTITY`                                               | That certificate's identity name                                                                            |
| `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | API-key notarization (preferred): `base64 -i AuthKey_<KEYID>.p8`                                            |
| or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`     | Apple-ID notarization                                                                                       |
| `POD_RELEASE_TOKEN`                                               | Only if releases go to a repo other than the one running the workflow: a token with `contents: write` there |

Both certificates belong to team `75Y2KR6P5W`. The updater's designated-requirement check pins the team, not the certificate, so CI and local releases update each other.

## Notes

- **Keep release outputs out of the worktree:** electron-builder packs the repository root into app.asar, minus upstream's denylist and `dist/`. Move an older `dist/` outside the checkout before the next release, never beside it. On 2026-10-10 two parked `dist-*` folders grew app.asar from 140 MB to 2.5 GB; the bundle gate now stops that.
- **Release repo:** `identity.updateFeed` (`outof-place/pod`) must stay public, so electron-updater can read releases without a token.
- **Updating from a local build:** installed copies update only from builds that satisfy the running app's designated requirement. An Apple Development–signed local build therefore cannot auto-update to a Developer ID release; install the first release DMG by hand.
- **Homebrew:** for the outof-place/homebrew-tap cask, take `sha256` from `shasum -a 256 dist/Pod-<version>-arm64.dmg`. `auto_updates true` keeps brew from fighting the in-app updater.

  ```ruby
  cask "pod" do
    version "0.1.0"
    sha256 "<sha256 of Pod-#{version}-arm64.dmg>"
    url "https://github.com/outof-place/pod/releases/download/v#{version}/Pod-#{version}-arm64.dmg"
    name "Pod"
    desc "Agent IDE by outofplace, built on Orca"
    homepage "https://pod.codes"
    auto_updates true
    depends_on arch: :arm64
    app "Pod.app"
    binary "#{appdir}/Pod.app/Contents/Resources/bin/podx"
    zap trash: ["~/Library/Application Support/Pod"]
  end
  ```
