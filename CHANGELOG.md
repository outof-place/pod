# Changelog

All notable changes to Pod are documented in this file. Orca's own changes are in the
[Orca changelog](https://onorca.dev/changelog); each Pod release names the Orca release it is built on.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Based on [Orca v1.4.223](https://github.com/stablyai/orca/releases/tag/v1.4.223).

### Added

- The Pod repository: README, contributing guide, this changelog and the license line for Pod's changes.
- `upstream.json`, which pins the Orca release Pod is built on.
- A daily upstream sync that rebases Pod onto each new stable Orca release, runs the typecheck,
  unit tests and macOS build, and opens a pull request or one tracking issue.
- `scripts/pod-stack.sh`, which assembles `main` from the topic branches listed in `pod-stack.json`, and
  `scripts/pod-workflow-quarantine.sh`, which keeps Orca's inherited workflows disabled.

[Unreleased]: https://github.com/outof-place/pod/compare/5272afeda68c2fe2bbdc3f09159c66688dc27328...main
