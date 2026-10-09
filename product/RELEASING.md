# Releasing the product (Developer ID, notarization, GitHub Releases)

A release is an arm64 DMG and zip of `<displayName>.app`. Both are signed with a **Developer ID Application** certificate, notarized by Apple and stapled. They are published as a GitHub release in `identity.updateFeed`'s repo, together with `latest-mac.yml`, which the in-app updater reads.

`product/release.sh` does the whole release. `.github/workflows/pod-release.yml` runs the same script when you push a `v<semver>` tag.

## One-time setup (the account holder does this by hand)

The keychain currently holds only an **Apple Development** identity (team `75Y2KR6P5W`). That identity signs local builds, but Apple will not notarize them.

1. **Apple Developer Program.** The team must be a paid member, and only the *Account Holder* can create Developer ID certificates. Check at <https://developer.apple.com/account> → Membership details.
2. **Developer ID Application certificate.** Use one of these two routes:
   - **Xcode:** Settings → Accounts → select the team → Manage Certificates → **+** → **Developer ID Application**.
   - **Web:**
     1. In Keychain Access, choose Certificate Assistant → Request a Certificate From a Certificate Authority, and save the CSR to disk.
     2. At <https://developer.apple.com/account/resources/certificates/add>, pick **Developer ID Application** (G2 Sub-CA) and upload the CSR.
     3. Download the `.cer` and double-click it to install.

   Verify:

   ```sh
   security find-identity -v -p codesigning
   # → "Developer ID Application: OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)"
   ```

3. **Notary credentials for local releases.** Store a notarytool keychain profile. Either use an app-specific password, created at <https://account.apple.com> → Sign-In and Security → App-Specific Passwords:

   ```sh
   xcrun notarytool store-credentials pod-notary \
     --apple-id "<apple id email>" --team-id 75Y2KR6P5W --password "<app-specific password>"
   ```

   Or use an App Store Connect API key. Create it at App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys, with the Developer role. The `.p8` downloads only once.

   ```sh
   xcrun notarytool store-credentials pod-notary \
     --key ~/keys/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <issuer uuid>
   ```

   Check the profile with `xcrun notarytool history --keychain-profile pod-notary`.
4. **CI secrets.** These go in the repo that runs the workflow, under Settings → Secrets and variables → Actions.

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | In Keychain Access → My Certificates, export the Developer ID Application certificate *with its key* as a `.p12`. Then run `base64 -i cert.p12 \| pbcopy`. |
   | `CSC_KEY_PASSWORD` | The password you set on that `.p12` |
   | `POD_SIGN_IDENTITY` | The exact identity name from `security find-identity` |
   | `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | API-key notarization (preferred): `base64 -i AuthKey_<KEYID>.p8` |
   | or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple-ID notarization |
   | `POD_RELEASE_TOKEN` | Only if releases go to a repo other than the one running the workflow: a token with `contents: write` there |

5. **Release repo.** Create `identity.updateFeed.owner/repo` (for example `outof-place/pod`). It must be public so electron-updater can read releases without a token.

## Cutting a release

Versions are plain semver, and every release must be higher than the last. A prerelease tag such as `v1.0.0-beta.1` is only offered to users who are already on a prerelease.

- **CI:**

  ```sh
  git tag v0.1.0 && git push origin v0.1.0
  ```

- **Local:**

  ```sh
  POD_SIGN_IDENTITY="Developer ID Application: OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)" \
  NOTARY_PROFILE=pod-notary \
    product/release.sh 0.1.0 --publish
  ```

`release.sh` does the following:

1. Builds the JS, mobile web bundle and native helpers. The helpers get the product's identifiers: `<appId>.computer-use` and the notification helper's `--bundle-id`.
2. Runs electron-builder with `product/electron-builder.pod.cjs` (`POD_RELEASE=1`, `ORCA_MAC_RELEASE=1`). That signs with hardened runtime and notarizes and staples the app.
3. Submits the DMG with `notarytool submit --wait` and staples it.
4. Re-hashes `latest-mac.yml`, since stapling changed the DMG.
5. Verifies with `codesign --verify --deep --strict`, `stapler validate` and `spctl --assess`.
6. Uploads the DMG, zip, zip blockmap and `latest-mac.yml` with `gh release create`.

## Notes

- **Updating from a local build:** installed copies update only from builds with the same signature. Squirrel.Mac checks the designated requirement. An Apple Development–signed local build therefore cannot auto-update to a Developer ID release; install the first release DMG by hand.
- **Homebrew:** for the outof-place/homebrew-tap cask, take `sha256` from `shasum -a 256 dist/Pod-<version>-arm64.dmg`. `auto_updates true` keeps brew from fighting the in-app updater.

  ```ruby
  cask "pod" do
    version "0.1.0"
    sha256 "<sha256 of Pod-#{version}-arm64.dmg>"
    url "https://github.com/outof-place/pod/releases/download/v#{version}/Pod-#{version}-arm64.dmg"
    name "Pod"
    desc "Agent IDE by outofplace, built on Orca"
    homepage "https://github.com/outof-place/pod"
    auto_updates true
    depends_on arch: :arm64
    app "Pod.app"
    zap trash: ["~/Library/Application Support/pod"]
  end
  ```
