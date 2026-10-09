# Product identity (downstream builds of Orca)

This directory turns an Orca checkout into a separately branded product. The first one is **Pod**
by outofplace, a downstream of [Orca](https://github.com/stablyai/orca) (MIT, Copyright (c) 2026
Lovecast Inc.) with an upstream-first policy: anything generic goes to stablyai/orca as a PR, and
this directory stays the only place that knows the product's names.

Without `product/`, or when a build does not ship `product-identity.json`, the app behaves exactly
like upstream Orca.

## `identity.json`

| Field | Used for |
|---|---|
| `displayName` | `productName` (bundle and dock name, `Pod.app`), the app menu, the About panel |
| `appId` | `CFBundleIdentifier`; also `<appId>.computer-use` for the Computer Use helper and the notification helper's identifier |
| `cliName` | The shell command the app installs (`/usr/local/bin/<cliName>`), never Orca's `orca` |
| `userDataName` | `~/Library/Application Support/<userDataName>` (the profile) |
| `keychainName` | Electron's safeStorage item `"<keychainName> Safe Storage"` / `"<keychainName> Key"` |
| `protocols` | URL schemes registered with macOS and accepted for deep links |
| `updateFeed` | `{ provider: "github", owner, repo }`: releases with `latest-mac.yml` for the in-app updater; `null` disables updates |
| `copyright`, `credits` | About panel; credits must name Orca and its MIT license |
| `legacyProfile` | The Orca profile to import on first launch (`null` = start fresh) |

Changing a name is a one-line edit here; nothing else in the repo hard-codes the product strings.

## How the identity reaches the app

- **Packaging:** `product/electron-builder.pod.cjs` wraps `config/electron-builder.config.cjs`.
  - It sets `appId`, `productName`, `protocols`, `copyright` and the artifact names.
  - It sets `extraMetadata.name` to `userDataName`, and keeps `orcaOfficialUpdates: false`.
  - It sets the `github` publish provider, which writes `app-update.yml` and `latest-mac.yml`.
  - It copies `identity.json` into `Contents/Resources/product-identity.json` and Orca's `LICENSE` into `ORCA-LICENSE.txt`.
  - It patches the bundled CLI launcher to the product's executable and profile.
- **Runtime:** `src/main/product-identity/product-identity.ts` reads the resource in packaged builds only, and refuses a malformed file.
  - Startup pins `userData` to `userDataName`.
  - It sets the pre-ready app name to `keychainName`, which names the keychain item.
  - It renames the app to `displayName` after `ready`.
  - It adds the credits to the About panel, accepts the identity's URL schemes, and installs `cliName`.
- **Updates:** `src/main/updater/update-feed-policy.ts` picks one of three feeds:
  - `official`: upstream Orca.
  - `disabled`: a fork with no feed of its own.
  - `product`: electron-updater's GitHub provider pointed at `updateFeed`.

  In product mode the official feed and Orca's nudge, changelog and pinned-build endpoints are never contacted. Neither is the agent-state-rules download from stablyai/orca releases.

## First launch: importing the Orca profile

`src/main/product-identity/legacy-profile-migration.ts` runs once, before the instance lock. It runs when the product's profile is missing or holds only Chromium bootstrap files. It never modifies anything that belongs to Orca:

1. **Orca must not be running.** If Orca's `SingletonLock` names a live process, the product shows "Quit Orca, then open Pod again" and exits. Databases copied under a running writer would be torn.
2. **Clone the profile.** `cpSync` with `COPYFILE_FICLONE` makes this an APFS clone, which is near-instant and takes no extra space.
   - It is copied into `.<userData>.migrating`, and published with a rename.
   - Caches, `Crashpad`, Chromium's `Singleton*` files, live sockets and `daemon/` are skipped.
   - A pid file guards against two first launches at once; a crashed attempt is redone.
3. **Hand over the terminals.**
   - For each live daemon whose protocol this build can attach (v1 to current), `daemon/daemon-v<N>.{sock,token,pid}` are symlinked into the new profile.
   - The product then adopts them like any older daemon after an upgrade: running sessions keep going.
   - New terminals run in the product's own daemon.
4. **Keep saved secrets.**
   - The product creates its own keychain item ("pod Safe Storage") holding the same secret as "orca Safe Storage". It does not re-encrypt anything.
   - So cookies, profile secrets and the `~/.orca/*.enc` token files, which both apps share, stay readable by both.
   - macOS asks once to let `security` read "orca Safe Storage" (Always Allow, with your login password). The product may ask once more for its own new item.
   - If either prompt is denied, the import still completes. Signed-in services just ask you to sign in again.
5. **Re-grant permissions.** macOS privacy grants (TCC) are tied to each app's signature. A one-time notice lists them and opens Privacy & Security:
   - Accessibility
   - Screen Recording
   - Full Disk Access
   - Automation
   - the Computer Use helper's Accessibility and Screen Recording
6. **Leave a marker.** `product-profile-migration.json` records the source, the time, the linked daemons and the keychain result.

### Going back, or redoing the import

- **Back to Orca:** quit the product and open Orca. Its profile, keychain item and daemons are untouched.
  - Terminals you opened in the product live in the product's own daemon, which Orca cannot see.
  - Changes made in the product (new workspaces, settings) stay in the product's profile.
- **Redo the import:** quit both apps, then run:

  ```sh
  rm -rf ~/Library/Application\ Support/pod
  security delete-generic-password -s 'pod Safe Storage' -a 'pod Key'
  ```

  Then open the product.

## Releasing

See [RELEASING.md](./RELEASING.md).
