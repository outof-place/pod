# Changelog

All notable changes to Pod are documented in this file. Orca's own changes are in the
[Orca changelog](https://onorca.dev/changelog). Pod is built on one Orca `main` commit, recorded in
`upstream.json`; each Pod release names the nearest Orca release of that commit.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/outof-place/pod/compare/v1.0.0-rc1...main
[1.0.0-rc1]: https://github.com/outof-place/pod/releases/tag/v1.0.0-rc1
