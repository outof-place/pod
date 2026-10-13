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
released under the MIT license. Orca does the heavy lifting. Pod is one commit on Orca's `main`
that passed Orca's own CI, plus a linear stack of patches that adds:

- the native Ghostty terminal and other macOS-only work;
- the Pod identity: name, icon, bundle id `codes.pod.app`, `pod://` links and the `podx` CLI;
- Stably-hosted services switched off;
- claude-acc built in (in progress);
- its own signed builds and update feed.

### Where to report bugs

1. Bugs in Pod: open an issue [here](https://github.com/outof-place/pod/issues).
2. Bugs in Claude Code itself, also when it runs in Pod: report them to
   [anthropics/claude-code](https://github.com/anthropics/claude-code/issues).
3. Report security problems privately through
   [a security advisory](https://github.com/outof-place/pod/security/advisories/new), not in a public issue.

Pod is not affiliated with or endorsed by Stably AI or Lovecast Inc. Orca is their trademark.

## Versions

- Pod is built on one Orca `main` commit whose GitHub Actions checks all passed, not on an Orca
  release. Pod no longer follows Orca's `main`: the base stays where it is.
- [`upstream.json`](../upstream.json) records that commit, its date and the nearest Orca release
  tag. Pod's release notes use the tag as the "Based on Orca vX" label.

| Branch | What it is |
| --- | --- |
| `main` (default) | The product: a green Orca `main` commit plus the Pod stack. |
| `feat/*`, `fix/*`, `perf/*` and other Orca-style names | Older changes once sent to Orca, still in the stack. |
| `pod/*` | Pod-only work, one branch per change. |

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

Orca's [contributing guide](CONTRIBUTING.md) covers the toolchain in depth.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first. The short version: Pod work goes on a `pod/*`
branch in this repository, one branch per change.

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
