# Contributing to Pod

Pod is Orca's code at a pinned `main` commit plus a stack of Pod patches; the sync with Orca ended
on 2026-10-13, and since 2026-10-17 `main` only moves forward. Orca's
[contributing guide](.github/CONTRIBUTING.md) covers setup and code standards, which apply here; its
pull request process does not. This file adds what is specific to Pod.

## Branch model

| Branch                                                                                   | What it is                                                                                                                                                                      | Who writes it                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `main` (default)                                                                         | The product. The pinned Orca commit, the stack as last assembled, its generated layers, then every commit landed since, each with a trailer.                                    | Fast-forward pushes only, after a green Pod check on the pushed commit. Never force, never rebuild it. |
| Orca-style topic branches: `feat/*`, `fix/*`, `perf/*`, `plugins/*`, `native-terminal/*` | Older changes once sent to Orca, assembled into `main` under their names. No new ones: Pod sends no changes to Orca.                                                            | Nobody.                                                                                                |
| `pod/*`                                                                                  | Pod-only work, one branch per change, landed on `main` by fast-forward. A branch you pushed is not rewritten: push a rebase under a new name.                                   | You.                                                                                                   |
| `stack/<topic>`                                                                          | A copy of a topic branch replayed onto the Pod stack while `main` was assembled, when two topic branches conflicted. Its `pod-stack.json` entry says what it was replayed onto. | Nobody now.                                                                                            |

- `fork/no-official-updater` predates the `pod/*` convention and keeps its name.

## Making a change

- Work on a `pod/*` branch cut from the latest `origin/main`. Others land on `main` directly, so
  run `git fetch` and read `git log origin/main` first.
- Keep Pod code in its own files and directories, and touch Orca files only with thin hooks.
- Make one logical change per commit, and give each its trailer (below).
- Write code in the form the generated layers leave (see "Generated layers"): import subprocess
  helpers from `@orca/process-host`, and never bring back a file `pod-prune` removed.
- Land it:
  1. Rebase onto the latest `origin/main`.
  2. Push it as a candidate branch `stack/cand-<n>`, run the [Pod check](.github/workflows/pod-check.yml)
     on it and get it green.
  3. `git push origin <sha>:refs/heads/main`, with no force. If it is refused as not a fast-forward,
     someone landed first: rebase, check again, push again.
- Never force-push `main`, and never rebuild it with `scripts/pod-stack.sh`: commits that landed
  directly are in no manifest branch, so a rebuild would drop them. `pod-stack.sh` refuses that
  (exit code 3) unless it is given `--allow-drop`; don't give it.

## Commit trailers

Every commit on `main` ends with exactly one of these trailers:

```text
Fork-only: Pod identity: name, bundle id, icon
Upstream: https://github.com/stablyai/orca/pull/26914
```

New commits are `Fork-only`, and their authors add the trailer. `Upstream` stays only on the older
entries that were sent to Orca, whose trailers `scripts/pod-stack.sh` added from the manifest.

## How `main` was built

Until 2026-10-17, `main` was assembled from topic branches. The files below record how its commits up
to that day were put together; `scripts/pod-stack.sh` can still dry-run that assembly, and nothing
else builds `main` now.

- [`upstream.json`](upstream.json) pins the Orca commit `main` sits on: `ref`, its `date`, and
  `nearestTag`, the newest Orca release whose branch point that commit contains. Release notes use
  `nearestTag` for the "Based on Orca vX" label. The sync with Orca ended on 2026-10-13, so the pin
  no longer moves.
- [`pod-stack-orca.json`](pod-stack-orca.json) freezes the Orca history that no entry replays: Orca's
  `main` where the sync ended and the tips of Orca's release branches. `pod-stack.sh` excludes
  those commits and reads no Orca remote.
- [`pod-stack.json`](pod-stack.json) lists the topic branches, in order, with their trailers.
- `scripts/pod-stack.sh` replays those branches onto the pinned commit. It is a dry run unless you
  pass `--apply` or `--push`. It stops on the first conflict with a report. It refuses to drop commits
  that are on `main` but in no listed branch, and to replace a `main` that is not a Pod build.
  Run `scripts/pod-stack.sh --help` for the options.
- Commits are deduplicated by patch id against everything stacked so far. A topic branch built on
  an older copy of an earlier entry replays only its own commits, so it needs no rebase when that
  entry is rewritten. If the older copy differs in content (same author, date and subject, other
  change), the run stops and names the files. Rebase the branch, or give its entry a `base` that
  excludes the old copy. An entry's `base` may be one ref or a list, and `ref` pins an entry to a
  commit for a snapshot run.
- An entry with `"squash": true`, an older branch with Orca `main` merged into it, is stacked as one
  commit: its net change since the Orca commit it last merged, because a commit-by-commit replay
  would lose the merges' conflict resolutions.
- Before it changes any ref, `pod-stack.sh` checks coverage. A pinned `ref` must contain its branch
  tip, unless the entry says why in `"hold"`. A `stack/*` copy names its `"source"` branch, and every
  commit of that branch must be in the result. A miss exits with code 4.
- Codemods over the whole stack are listed under `"generated"` in `pod-stack.json` and run by
  `scripts/pod-generated.sh`: one commit per layer on top of the stack, trailed `Pod-Generated:`.
  A codemod that fails, or whose `check` command finds work left, stops the run with nothing
  committed.

## Checks

The [Pod check](.github/workflows/pod-check.yml) workflow runs the generated-layer check, the
typecheck and the unit tests on `main` or a candidate branch (`stack/cand-*`), on demand only:
`gh workflow run pod-check.yml -R outof-place/pod -f ref=stack/cand-<n>`. Add `--ref <branch>` to
run the workflow file of that branch instead of `main`'s. Every run costs Actions minutes, so other
branches are refused. The macOS build runs only with `-f macos=true` (before a release); a
checklist's "macOS build" is a local build, never this check. The claude-acc payload comes through
the `POD_PAYLOAD_TOKEN` secret once claude-acc is private (`config/scripts/github-release-asset.mjs`).

## Generated layers

`main` carries the generated layers in its history, and commits land on top of them. Nothing reruns
a codemod after a commit lands, so every commit must leave each layer current:
`scripts/pod-generated.sh --check` runs each layer's `check` in the checkout and exits with code 5
if one finds work left. The Pod check runs it before the typecheck. Fix a failure by running that
layer's `run` command (listed in `pod-stack.json`) and committing the result with your change.

## Inherited Orca workflows

The Orca workflows under `.github/workflows` are disabled in this repository: they need Stably's
secrets, and some deploy Stably's infrastructure. A workflow file that first appears in a push is
registered as active and starts at once, so run `scripts/pod-workflow-quarantine.sh` after every
push to `main` (`pod-stack.sh --push` ran it by itself). It disables every workflow Pod does not own
and cancels their unfinished runs. Pod's own workflows are the files named `pod-*.yml`; name new
ones that way.

## Maintainers: the macOS build runner

The Pod check workflow builds on the standard `macos-15` runner: 3 M1 cores, free for public
repositories. If `pnpm build` runs out of memory there, set the `POD_MAC_RUNNER` repository variable:

- `macos-15-xlarge`: 5 M2 cores and 14 GB of memory. Larger runners are billed per minute even on
  public repositories, so this needs a payment method on the `outof-place` organization.
- A self-hosted Mac: give it a label of its own, for example `pod-mac`, and set the variable to that
  label. Self-hosted runners cost nothing on GitHub's side. This workflow runs only on demand, never
  on pull requests, so code from forks never reaches the machine.

```sh
gh variable set POD_MAC_RUNNER -R outof-place/pod -b macos-15-xlarge
```

Delete the variable to go back to `macos-15`.
