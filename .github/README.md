<h1 align="center">Pod</h1>

<p align="center">
  <strong>Run a whole pod of coding agents in parallel, natively on your Mac.</strong><br />
  A macOS distribution of <a href="https://github.com/stablyai/orca">Orca</a>, by <a href="https://outofplace.space">outofplace</a>.
</p>

<p align="center">
  <a href="https://github.com/outof-place/pod/releases/latest"><strong>Download for macOS</strong></a>
  &nbsp;·&nbsp;
  <a href="https://pod.codes">pod.codes</a>
  &nbsp;·&nbsp;
  <a href="../CHANGELOG.md">Changelog</a>
</p>

```sh
brew install --cask outof-place/tap/pod
```

> [!NOTE]
> Pod is early. The first signed and notarized build is still on its way, so until it is out,
> [build from source](#build-from-source). The [changelog](../CHANGELOG.md) lists what has shipped.

## Why Pod

- **A native terminal.** Terminals draw with [Ghostty](https://ghostty.org) on Metal in a real
  macOS view, not in a web canvas.
- **Many agents on one Mac.** Pod is built for dozens of agents and dev servers at once.
  [claude-acc](https://github.com/outof-place/claude-acc), the outofplace toolkit that keeps a
  busy Mac responsive, is moving into Pod.
- **macOS first.** Pod is built, signed and notarized for macOS, installs with Homebrew and
  updates itself from this repository's releases.
- **No hosted services.** Pod turns off Orca's Stably-hosted features: telemetry, the mobile relay,
  push notifications, share links and in-app feedback.
- **Free and open source.** MIT, like Orca. Pod is a studio showcase with no paid tier.

## Relationship to Orca

Pod is a downstream macOS distribution of [Orca](https://github.com/stablyai/orca) by Stably AI,
released under the MIT license. Orca does the heavy lifting. Pod is the newest commit on Orca's
`main` that passed Orca's own CI, plus a short, linear stack of patches that adds:

- the native Ghostty terminal and other macOS-only work;
- the Pod identity: name, icon, bundle id `codes.pod.app`, `pod://` links and the `podx` CLI;
- Stably-hosted services switched off;
- claude-acc built in (in progress);
- its own signed builds and update feed.

### What we send upstream

Anything generic goes to Orca as a pull request first. Status updates live:

| Orca pull request | Change | Status |
| --- | --- | --- |
| [#26914](https://github.com/stablyai/orca/pull/26914) | Experimental native Ghostty terminal view on macOS | ![status](https://img.shields.io/github/pulls/detail/state/stablyai/orca/26914?label=) |
| [#26927](https://github.com/stablyai/orca/pull/26927) | Name Multipass recipe VMs and emit an SSH connection | ![status](https://img.shields.io/github/pulls/detail/state/stablyai/orca/26927?label=) |
| [#26945](https://github.com/stablyai/orca/pull/26945) | Build the Computer Use helper with Swift 6.4's default build system | ![status](https://img.shields.io/github/pulls/detail/state/stablyai/orca/26945?label=) |
| [#26953](https://github.com/stablyai/orca/pull/26953) | Status bar items and live panel messaging for plugins | ![status](https://img.shields.io/github/pulls/detail/state/stablyai/orca/26953?label=) |
| [#26956](https://github.com/stablyai/orca/pull/26956) | Keep xterm parse barriers, and the output behind them, across a resize | ![status](https://img.shields.io/github/pulls/detail/state/stablyai/orca/26956?label=) |

All of them: [pull requests from outof-place on stablyai/orca](https://github.com/stablyai/orca/pulls?q=is%3Apr+author%3Aoutof-place).

### Upstream first

- A change that would help Orca users goes to Orca as a pull request before, or alongside, Pod.
- Pod carries a patch only until it lands on Orca's `main`, then drops it on the next rebase.
- Only Pod's identity, packaging, update feed and product decisions stay fork-only.
- Every commit on `main` says which kind it is, in a trailer:
  `Upstream: <Orca pull request URL>` or `Fork-only: <reason>`.

### Where to report bugs

1. Reproduce the problem on the official [Orca](https://onorca.dev) build first.
2. If it happens there too, it is an Orca bug: report it to
   [stablyai/orca](https://github.com/stablyai/orca/issues). Please don't send Pod reports to the Orca team.
3. If it happens only in Pod, open an issue [here](https://github.com/outof-place/pod/issues).
4. Report security problems privately through
   [a security advisory](https://github.com/outof-place/pod/security/advisories/new), not in a public issue.

Pod is not affiliated with or endorsed by Stably AI or Lovecast Inc. Orca is their trademark.

## Versions

- Pod tracks Orca's `main`, not its releases. Every Pod build sits on one Orca `main` commit whose
  GitHub Actions checks all passed.
- [`upstream.json`](../upstream.json) records that commit, its date and the nearest Orca release
  tag. Pod's release notes use the tag as the "Based on Orca vX" label.
- A daily job moves Pod to the newest green Orca commit. It runs the typecheck, the unit tests and
  the macOS build, then opens a pull request, or one tracking issue when the rebase needs a hand.
- We aim to ship Orca's security fixes in Pod within 48 hours of the fix landing on Orca's `main`.

| Branch | What it is |
| --- | --- |
| `main` (default) | The product: a green Orca `main` commit plus the Pod stack. |
| `orca-main` | An untouched mirror of Orca's `main`, updated daily. |
| `feat/*`, `fix/*`, `perf/*` and other Orca-style names | One branch per Orca pull request. |
| `pod/*` | Pod-only work, one branch per change. |
| `sync/orca-main` | The next rebase, prepared by the sync job and waiting for review. |

## Build from source

You need macOS with the Xcode command line tools, Node 24, and the pnpm version pinned in
`package.json` (`corepack enable` installs it). Tests also need the Bun version in
`config/.bun-version`.

```sh
git clone https://github.com/outof-place/pod.git
cd pod
corepack enable
pnpm install
pnpm dev            # run from source
pnpm build:unpack   # build an unsigned, unpacked app
```

Orca's [contributing guide](CONTRIBUTING.md) covers the toolchain in depth; all of it applies to Pod.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first. The short version: if your change would help every
Orca user, it belongs in [Orca](https://github.com/stablyai/orca), and Pod picks it up from there.

## License

MIT. See [LICENSE](../LICENSE).

- Copyright (c) 2026 Lovecast Inc. (Orca)
- Copyright (c) 2026 Outofplace Poland sp. z o.o. (Pod's changes)

## Credits

- [Orca](https://github.com/stablyai/orca) by Stably AI (Lovecast Inc.), MIT: the app Pod is built on.
- [Ghostty](https://github.com/ghostty-org/ghostty) by Mitchell Hashimoto and contributors, MIT:
  the terminal engine behind the native terminal view.
- [libghostty-spm](https://github.com/Lakr233/libghostty-spm) by Lakr233, MIT: the prebuilt
  GhosttyKit framework Pod links.
- [Electron](https://www.electronjs.org), [xterm.js](https://xtermjs.org) and every other
  open-source package listed in `package.json`.

Made by [outofplace](https://outofplace.space).
