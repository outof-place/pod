# Changelog

All notable changes to Pod are documented in this file. Orca's own changes are in the
[Orca changelog](https://onorca.dev/changelog). Pod tracks Orca's `main`; each Pod release names the
nearest Orca release of the commit it is built on.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Based on [Orca v1.4.223](https://github.com/stablyai/orca/releases/tag/v1.4.223). The exact Orca `main` commit is in `upstream.json`.

### Added

- The Pod repository: README, contributing guide, this changelog and the license line for Pod's changes.
- `upstream.json`, which pins the Orca `main` commit Pod is built on, with its date and nearest Orca release tag.
- A daily upstream sync that moves Pod to the newest Orca `main` commit whose checks all passed, runs the typecheck,
  unit tests and macOS build, and opens a pull request or one tracking issue.
- `scripts/pod-orca-base.sh`, which finds that green commit and writes `upstream.json`.
- `scripts/pod-stack.sh`, which assembles `main` from the topic branches listed in `pod-stack.json`, and
  `scripts/pod-workflow-quarantine.sh`, which keeps Orca's inherited workflows disabled.

[Unreleased]: https://github.com/outof-place/pod/compare/5272afeda68c2fe2bbdc3f09159c66688dc27328...main
