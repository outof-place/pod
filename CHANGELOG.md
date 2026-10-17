# Changelog

All notable changes to Pod are documented in this file. Orca's own changes are in the
[Orca changelog](https://onorca.dev/changelog). Pod is built on one Orca `main` commit, recorded in
`upstream.json`; each Pod release names the nearest Orca release of that commit.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- claude-acc 1.34.2 is built in (from `release/1.34.2`): when Homebrew stops a `brew upgrade` on one formula it can't
  build, the formulae still outdated update one by one, so only the one that failed is reported.

## [1.0.0-rc3] - 2026-10-16

A fix for 1.0.0-rc2: [Pod-1.0.0-rc3.dmg](https://github.com/outof-place/pod/releases/download/v1.0.0-rc3/Pod-1.0.0-rc3.dmg).
From rc2, "Check for Updates…" installs it; from rc1, install it by hand over the running Pod.

### Fixed

- Pod no longer quits every minute or two while apps started from its terminals run: it kept watching an app it had
  let go of, and macOS's next notice about that app crashed it.

## [1.0.0-rc2] - 2026-10-16

The second release candidate for Pod 1.0: [Pod-1.0.0-rc2.dmg](https://github.com/outof-place/pod/releases/download/v1.0.0-rc2/Pod-1.0.0-rc2.dmg).
Install it by hand, also over 1.0.0-rc1: rc2 is signed with a new update key, so rc1's "Check for Updates…"
reports an improperly signed feed. Releases after rc2 arrive through "Check for Updates…" again.

### Added

- Tabs in the title bar, like Safari's: every tab closes with its × or a middle click, a long row scrolls sideways,
  and the menu at its end lists every tab. Diffs, files and images open as tabs. Closing a tab shows the one to its
  right.
- Each worktree remembers its last tab, so switching projects or worktrees brings it back.
- One small agent mark per tab and per row in the sidebar and in Activity: a turning ring while an agent works, a
  bell when it needs you, a green dot for an unseen finish, a red cross for a failure.
- Project icons, found in the repository or chosen with Change Project Icon…, and project order by drag or by Move
  Up, Move Down, Move to Top and Move to Bottom.
- Hide worktrees from their menu, and bring them back from View › Hidden Worktrees…. A hidden worktree comes back
  while its agent waits for you. Each project also chooses whether worktrees created outside Pod show up.
- ⌘-click a file path in a terminal to open it as a tab at its line and column; ⇧⌘-click opens it in its default app.
- The browser pane shows where a hovered link goes, and ⌘-click opens it in the default browser.
- Runtime RPCs for SSH host settings, AI vault session delete and the network proxy, for PodNative's coming native
  settings.

### Changed

- The sidebar shows one row per project: its icon, its name once, and its other worktrees under it. A branch shows
  only when it isn't the default one, and the bottom line appears only while Pod connects or after an error.
- Activity lists agents that need you first, longest wait first, then one section per project with finished sessions
  folded. The Dock badge counts agents that need you, and notifications say "Claude needs you".
- claude-acc's usage moved from the window's toolbar to the menu bar (Pod Menu).
- claude-acc 1.34.1 is built in (from `release/1.34.1`).
- Updates are signed with a new Sparkle key.

### Removed

- Activity's Group By, Show Unread Only, Show Child Agents, Compact Mode and Show Search options.
- The Close Tab toolbar button and the Pod mark with the branch name in the title bar.

### Fixed

- Pod no longer replaces a newer claude-acc with the copy it carries (rc1 replaced 1.33.0 with 1.31.15 on one Mac),
  and it stays out of the way once claude-acc was handed back to Homebrew.

### Known issues

- **Quitting an app that was started directly from a Pod terminal (for example by running its binary) can end all of
  Pod's terminal sessions about a minute later.** Start apps with `open -a <App>`, or from the Dock or Finder, instead.
  A fix lands before 1.0.
- **Relative links in the Markdown preview (for example `[x](docs/a.md)`) aren't clickable yet.** Only http, https and
  mailto links open.

## [1.0.0-rc1] - 2026-10-14

The first release candidate for Pod 1.0: [Pod-1.0.0-rc1.dmg](https://github.com/outof-place/pod/releases/download/v1.0.0-rc1/Pod-1.0.0-rc1.dmg),
signed with the studio's Developer ID and notarized by Apple. Test builds don't update themselves: install this one
by hand from the DMG. Later releases arrive through Pod's own "Check for Updates…".

Pod needs macOS 27 or later on a Mac with Apple silicon.

Based on [Orca v1.4.224](https://github.com/stablyai/orca/releases/tag/v1.4.224). The exact Orca `main` commit is in `upstream.json`.

### Added

- A native terminal: each pane runs Ghostty's engine in a native macOS view, drawn with Metal.
- claude-acc, built in: subscription rotation, a dev-server memory guard, memory-aware builds, cleanup, stay awake and
  fan control. Claude accounts are added through claude-acc: in Settings › Accounts, or with `claude-acc add` in a
  terminal.
- No telemetry: Orca's telemetry, relay, push, share and feedback services are switched off.
- The Pod repository: README, contributing guide, this changelog and the license line for Pod's changes.
- `upstream.json`, which pins the Orca `main` commit Pod is built on, with its date and nearest Orca release tag.
- `scripts/pod-stack.sh`, which assembles `main` from the topic branches listed in `pod-stack.json`, and
  `scripts/pod-workflow-quarantine.sh`, which keeps Orca's inherited workflows disabled.

### Known issues

- **Quitting an app that was started directly from a Pod terminal (for example by running its binary) can end all of
  Pod's terminal sessions about a minute later.** Start apps with `open -a <App>`, or from the Dock or Finder, instead.
  A fix lands before 1.0.
- **Relative links in the Markdown preview (for example `[x](docs/a.md)`) aren't clickable yet.** Only http, https and
  mailto links open.

[Unreleased]: https://github.com/outof-place/pod/compare/v1.0.0-rc2...main
[1.0.0-rc2]: https://github.com/outof-place/pod/releases/tag/v1.0.0-rc2
[1.0.0-rc1]: https://github.com/outof-place/pod/releases/tag/v1.0.0-rc1
