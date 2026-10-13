# Contributing to Pod

Pod is Orca's code at a recent, green `main` commit plus a short stack of Pod patches. Orca's
[contributing guide](.github/CONTRIBUTING.md) covers setup, code standards and pull requests, and
all of it applies here. This file adds what is specific to Pod.

## Branch model

| Branch | What it is | Who writes it |
| --- | --- | --- |
| `main` (default) | The product. A green Orca `main` commit plus a linear stack of Pod commits, each with a trailer. | `scripts/pod-stack.sh`, always with a lease. Don't commit to it directly. |
| `orca-main` | A copy of Orca's `main` from the last upstream sync. Nothing updates it any more. | Nobody. |
| Orca-style topic branches: `feat/*`, `fix/*`, `perf/*`, `plugins/*`, `native-terminal/*` | One branch per Orca pull request, cut from Orca's `main`. | You. |
| `pod/*` | Pod-only work, one branch per change. `pod/infra` holds these docs, `upstream.json`, the check workflow and the stack scripts. | You. |
| `stack/<topic>` | A copy of a topic branch replayed onto the Pod stack, when two topic branches conflict with each other. Its `pod-stack.json` entry says what it was replayed onto. | Whoever settles the conflict. Refresh it when its source branch changes, or drop it once the source is rebased. |

- Branches keep their names once they have an open Orca pull request.
- Don't name local branches `upstream/*`: the `upstream` remote (Orca) makes `upstream/<name>`
  ambiguous with its remote-tracking branches.
- `fork/no-official-updater` predates the `pod/*` convention and keeps its name.

## Does this belong upstream?

Answer this before writing code. Most changes belong in [Orca](https://github.com/stablyai/orca).

| Your change | Where it goes |
| --- | --- |
| Fixes a bug that also happens in the official Orca build | Orca |
| Improves something Orca already has, on any platform | Orca |
| Makes Orca easier to package or fork, for example reading an id from one place | Orca |
| A macOS-only feature Orca might want, such as the native terminal | Orca, and Pod carries it until it lands |
| Pod's name, icon, bundle id, packaging, signing or update feed | Pod only |
| Turning off a Stably-hosted service | Pod only |
| A product decision Orca has declined | Pod only, with the reason |

When unsure, open the Orca pull request. A declined pull request becomes a fork-only patch, and
the reason it was declined goes in its trailer.

## Sending a change to Orca

1. Branch from Orca's `main`, for example `git switch -c fix/<topic> upstream/main`. Follow
   Orca's branch naming (see their guide).
2. Follow Orca's guide and pull request template, and open the pull request against `stablyai/orca`.
3. To ship it in Pod before Orca does, add the branch to [`pod-stack.json`](pod-stack.json) with
   `"upstream": "<pull request URL>"`.

## Pod-only changes

- Work on a `pod/*` branch. Changes to these docs and the Pod tooling go on `pod/infra`.
- Keep Pod code in its own files and directories, and touch Orca files only with thin hooks.
  Every line changed in an Orca file is a possible conflict on each rebase.
- Make one logical change per commit.
- Add the branch to `pod-stack.json` with `"forkOnly": "<reason>"`.

## Commit trailers

Every commit on `main` ends with exactly one of these trailers:

```text
Upstream: https://github.com/stablyai/orca/pull/26914
Fork-only: Pod identity: name, bundle id, icon
```

`scripts/pod-stack.sh` adds them from the manifest, so topic branches do not have to.

## How `main` is built

- [`upstream.json`](upstream.json) pins the Orca commit `main` sits on: `ref`, its `date`, and
  `nearestTag`, the newest Orca release whose branch point that commit contains. Release notes use
  `nearestTag` for the "Based on Orca vX" label. Orca tags sit on release branches, so `git
  describe` cannot find them; `scripts/pod-orca-base.sh pin <sha>` computes the file.
- A commit is green when every GitHub Actions check suite on it has completed and every check run
  passed or was skipped. `scripts/pod-orca-base.sh green` prints the newest green commit on Orca's
  `main`.
- [`pod-stack.json`](pod-stack.json) lists the topic branches, in order, with their trailers.
- `scripts/pod-stack.sh` replays those branches onto the pinned commit, or onto another one with
  `--onto <sha>` or `--green`. It is a dry run unless you pass
  `--apply` or `--push`. It stops on the first conflict with a report. It refuses to drop commits
  that are on `main` but in no listed branch, and to replace a `main` that is not a Pod build.
  Run `scripts/pod-stack.sh --help` for the options.
- Commits are deduplicated by patch id against everything stacked so far. A topic branch built on
  an older copy of an earlier entry replays only its own commits, so it needs no rebase when that
  entry is rewritten. If the older copy differs in content (same author, date and subject, other
  change), the run stops and names the files. Rebase the branch, or give its entry a `base` that
  excludes the old copy. An entry's `base` may be one ref or a list, and `ref` pins an entry to a
  commit for a snapshot run.
- An upstream pull request branch that maintainers update by merging Orca `main` into it gets
  `"squash": true`: it is stacked as one commit, its net change since the Orca commit it last
  merged, because a commit-by-commit replay would lose the merges' conflict resolutions.
- Before it changes any ref, `pod-stack.sh` checks coverage. A pinned `ref` must contain its branch
  tip, unless the entry says why in `"hold"`. A `stack/*` copy names its `"source"` branch, and every
  commit of that branch must be in the result. A miss exits with code 4.
- Codemods over the whole stack are listed under `"generated"` in `pod-stack.json` and run by
  `scripts/pod-generated.sh`: one commit per layer on top of the stack, trailed `Pod-Generated:`.
  Every assembly drops the old layer and runs the codemod again, so the layer never conflicts. A
  codemod that fails, or whose `check` command finds work left, stops the run with nothing
  committed.
- A pull request that Orca has merged leaves the manifest. Squash merges are not caught by the
  patch-id dedupe, so check that the merged commit matches the branch, then drop the entry.
- The [Pod check](.github/workflows/pod-check.yml) workflow runs the typecheck, the unit tests and
  the macOS build on a branch or commit, on demand only:
  `gh workflow run pod-check.yml -R outof-place/pod -f ref=main`.

## Inherited Orca workflows

The Orca workflows under `.github/workflows` are disabled in this repository: they need Stably's
secrets, and some deploy Stably's infrastructure. A workflow file that first appears in a push is
registered as active and starts at once, so every push `pod-stack.sh --push` makes is followed by
`scripts/pod-workflow-quarantine.sh`. It disables every workflow Pod does not own and cancels their
unfinished runs. If you push to `main` any other way, run it yourself. Pod's own workflows are the
files named `pod-*.yml`; name new ones that way.

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
