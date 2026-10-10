# Product identity (downstream builds of Orca)

This directory turns an Orca checkout into a separately branded product. The first one is **Pod**
by outofplace, a downstream of [Orca](https://github.com/stablyai/orca) (MIT, Copyright (c) 2026
Lovecast Inc.) with an upstream-first policy: anything generic goes to stablyai/orca as a PR, and
this directory stays the only place that knows the product's names.

Without `product/`, or when a build does not ship `product-identity.json`, the app behaves exactly
like upstream Orca.

## `identity.json`

| Field                    | Used for                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName`            | `productName` (bundle and dock name, `Pod.app`), the app menu, the About panel                                                                                |
| `appId`                  | `CFBundleIdentifier`; Electron's helpers get `<appId>.helper*`, the Computer Use helper `<appId>.computer-use`, the notification helper `--bundle-id <appId>` |
| `packageName`            | `package.json` `name` inside the app                                                                                                                          |
| `cliName`                | The shell command the app installs (`/usr/local/bin/<cliName>`, shipped as `Resources/bin/<cliName>`), never Orca's `orca`                                    |
| `userDataName`           | `~/Library/Application Support/<userDataName>` (the profile)                                                                                                  |
| `keychainName`           | Electron's safeStorage item `"<keychainName> Safe Storage"` / `"<keychainName> Key"`                                                                          |
| `protocols`              | URL schemes registered with macOS and accepted for deep links                                                                                                 |
| `homepage`               | `package.json` `homepage` (https only)                                                                                                                        |
| `updateFeed`             | `{ provider: "github", owner, repo }`: releases with `latest-mac.yml` for the in-app updater; `null` disables updates                                         |
| `copyright`, `credits`   | About panel; credits must name Orca and its MIT license. The panel also names the Orca base (`upstream.json`)                                                 |
| `stablyServices`         | `false` turns off Stably-hosted services (owned by the overlay that reads it)                                                                                 |
| `computerUseDisplayName` | The Computer Use helper's name in Privacy & Security                                                                                                          |
| `legacyProfile`          | The Orca profile to import on first launch: its `userDataName` and `keychainName` (`null` = start fresh)                                                      |

Changing a name is a one-line edit here; nothing else in the repo hard-codes the product strings.

## How the identity reaches the app

- **Packaging:** `product/electron-builder.pod.cjs` wraps `config/electron-builder.config.cjs`, macOS only (the Windows and Linux sections are dropped).
  - It sets `appId`, `productName`, `protocols`, `copyright`, the artifact names, and the usage strings macOS shows in permission prompts.
  - It sets `extraMetadata.name` to `packageName`, and keeps `orcaOfficialUpdates: false`.
  - It sets the `github` publish provider, which writes `app-update.yml` and `latest-mac.yml`.
  - It copies `identity.json` into `Contents/Resources/product-identity.json` and Orca's `LICENSE` into `ORCA-LICENSE.txt`, and writes `product-upstream.json` (the Orca tag and commit, from `upstream.json` or git).
  - It patches the bundled CLI launcher to the product's executable and profile, and adds it as `bin/<cliName>` next to `bin/orca`.
  - It renames the Computer Use helper to `computerUseDisplayName` before the helper is signed.
  - With `config/pod-acc-extra-resources.cjs` in the stack, it ships the claude-acc payload, its Python and the distro plugins. A payload with pod-acc-run also gets its launchd plists and Pod Menu.app in Contents/Library, where SMAppService looks.
- **Runtime:** `src/main/product-identity/product-identity.ts` reads the resource in packaged builds only, and refuses a malformed file.
  - Startup pins `userData` to `userDataName`.
  - It sets the pre-ready app name to `keychainName`, which names the keychain item.
  - It renames the app to `displayName` after `ready`.
  - It adds the credits and the Orca base to the About panel, accepts the identity's URL schemes, and installs `cliName`.
- **Updates:** `src/main/updater/update-feed-policy.ts` picks one of three feeds:
  - `official`: upstream Orca.
  - `disabled`: a fork with no feed of its own.
  - `product`: electron-updater's GitHub provider pointed at `updateFeed`.

  In product mode the official feed and Orca's nudge, changelog and pinned-build endpoints are never contacted. Neither is the agent-state-rules download from stablyai/orca releases.

## First launch: importing the Orca profile

`src/main/product-identity/legacy-profile-migration.ts` runs once, before the instance lock. It runs when the product's profile is missing or holds only Chromium bootstrap files. It never modifies anything that belongs to Orca:

1. **Orca must not be running.** If Orca's `SingletonLock` names a live process, the product shows "Quit Orca, then open Pod again" and exits. Databases copied under a running writer would be torn.
2. **Clone the profile, in two halves.** Every file is an APFS clone (`copyFile` with `COPYFILE_FICLONE | COPYFILE_EXCL`), which takes no extra space. A purpose-built walker does it, because `fs.cp` spends most of its time on per-file `stat`/`utimes` calls.
   - **Before `ready`, with no UI:** everything except `DEFERRED_PROFILE_ENTRIES` (in `profile-clone.ts`). It is copied into `.<userData>.migrating` and published with a rename. A pid file guards against two first launches at once; a crashed attempt is redone.
   - **After `ready`, before the first window:** the deferred entries. These are browser partitions, the session-search index, speech models, account stores and logs. They are cloned by 64 parallel workers, behind a small window that shows a progress bar and an "N of M files" count, and in the dock icon. Files the app already created are kept. The marker lists what is pending, so an interrupted import resumes on the next launch.
   - Measured on a 22k-file profile on a heavily loaded Mac (load average 50 to 110): the half before the first frame went from 7.3 s to 1.0 s, and the deferred half cloned 19k files in 20 s.
   - Caches (also inside partitions), `Crashpad`, Chromium's `Singleton*` files, live sockets and `daemon/` are skipped.
3. **Running terminals stay with Orca unless you move them.** Daemons live in `<userData>/daemon/daemon-v<N>.{sock,token,pid}`, so by default the two apps never touch each other's terminals. The import only lists Orca's live daemons of an older protocol in the marker (`adoptableDaemons`).
   - **Opt-in move:** on the first interactive launch with Orca quit, the product asks "Move running terminals from Orca?" (default: keep them). `POD_ADOPT_ORCA_TERMINALS=1` moves them without asking.
   - A move links each endpoint file into the product's `daemon/` and then unlinks it from Orca's, so nothing is overwritten. It stays on the same volume, and dead or unattachable daemons are never touched. The marker records it under `daemonHandover`.
   - The product reattaches the moved sessions like any older daemon after an upgrade. Orca's next launch finds no endpoint at its own path and starts fresh terminals, so the two apps never share a PTY.
   - A moved daemon notices within about 60 s that its old name is gone. From then on it refuses new terminals but keeps serving its existing ones, and it exits once they end.
4. **Keep saved secrets.**
   - The product creates its own keychain item ("Pod Safe Storage") holding the same secret as "orca Safe Storage". It does not re-encrypt anything.
   - So cookies, profile secrets and the `~/.orca/*.enc` token files, which both apps share, stay readable by both.
   - macOS asks once to let `security` read "orca Safe Storage" (Always Allow, with your login password). The product may ask once more for its own new item.
   - If either prompt is denied, the import still completes. Signed-in services just ask you to sign in again.
   - Managed Claude accounts stay in "Orca Claude Code Managed Credentials", which both apps share. Their refresh tokens rotate, so a copy would go stale.
5. **Re-grant permissions.** macOS privacy grants (TCC) are tied to each app's signature. A one-time notice lists them and opens Privacy & Security:
   - Accessibility
   - Screen Recording
   - Full Disk Access
   - Automation
   - the Computer Use helper's Accessibility and Screen Recording
6. **Leave a marker.** `product-profile-migration.json` records the source, the time, the linked daemons, the keychain result and the deferred entries.

### Going back, or redoing the import

- **Back to Orca:** quit the product and open Orca. Its profile and keychain item are untouched.
  - Terminals you opened in the product live in the product's own daemon, which Orca cannot see.
  - Changes made in the product (new workspaces, settings) stay in the product's profile.
  - If you moved Orca's running terminals, move them back first, with the product quit:

    ```sh
    ELECTRON_RUN_AS_NODE=1 /Applications/Pod.app/Contents/MacOS/Pod \
      /Applications/Pod.app/Contents/Resources/restore-orca-terminals.mjs
    ```

    It refuses while the product runs. It skips any daemon whose name Orca has already reused, rather than overwriting it.
- **Redo the import:** quit both apps, then run:

  ```sh
  rm -rf ~/Library/Application\ Support/Pod
  security delete-generic-password -s 'Pod Safe Storage' -a 'Pod Key'
  ```

  Then open the product.

## Releasing

See [RELEASING.md](./RELEASING.md).
