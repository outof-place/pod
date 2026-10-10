# Contributing to Pod

Pod is Orca's code at a recent, green `main` commit plus a short stack of Pod patches. Orca's
[contributing guide](.github/CONTRIBUTING.md) covers setup, code standards and pull requests, and
all of it applies here. This file adds what is specific to Pod.

## Branch model

| Branch | What it is | Who writes it |
| --- | --- | --- |
| `main` (default) | The product. A green Orca `main` commit plus a linear stack of Pod commits, each with a trailer. | `scripts/pod-stack.sh` and the sync workflow, always with a lease. Don't commit to it directly. |
| `orca-main` | An untouched mirror of Orca's `main`. | The sync workflow, fast-forward only. |
| Orca-style topic branches: `feat/*`, `fix/*`, `perf/*`, `plugins/*`, `native-terminal/*` | One branch per Orca pull request, cut from `orca-main`. | You. |
| `pod/*` | Pod-only work, one branch per change. `pod/infra` holds these docs, `upstream.json`, the sync workflow and the stack scripts. | You. |
| `stack/<topic>` | A copy of a topic branch replayed onto the Pod stack, when two topic branches conflict with each other. Its `pod-stack.json` entry says what it was replayed onto. | Whoever settles the conflict. Refresh it when its source branch changes, or drop it once the source is rebased. |
| `sync/orca-main` | The next rebase of `main` onto a newer green Orca commit, prepared by the sync workflow and waiting for review. | The sync workflow. |

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

1. Branch from Orca's `main`, for example `git switch -c fix/<topic> origin/orca-main`. Follow
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
- A pull request that Orca has merged leaves the manifest. Squash merges are not caught by the
  patch-id dedupe, so check that the merged commit matches the branch, then drop the entry.
- The [upstream sync](.github/workflows/upstream-sync.yml) workflow runs daily. It fast-forwards
  `orca-main`. When Orca's `main` has a newer green commit, it rebases `main` into
  `sync/orca-main`, runs the typecheck, unit tests, the daemon protocol crossing check and the
  macOS build, and opens or refreshes the one "Rebase on Orca main" pull request. A conflict or a
  failed check opens or updates one `upstream-sync` issue instead. The cross-version wire journeys
  run too, but only as advisory, and their result goes into the pull request body.
- "Green" covers only the workflows Orca runs on a push to `main`. Orca's unit suite runs on pull
  requests, so the sync's own unit run is the first full test of that exact commit.
- To run only the checks on any branch or commit, without a rebase, pull request or issue:
  `gh workflow run upstream-sync.yml -R outof-place/pod -f check=main`.
- Do not press Merge on a sync pull request: a rebase replaces the branch. Promote it with
  `gh workflow run upstream-sync.yml -R outof-place/pod -f promote=true`, which moves
  `main` with a lease and checks that the branch has not changed since its checks passed.

## Inherited Orca workflows

The Orca workflows under `.github/workflows` are disabled in this repository: they need Stably's
secrets, and some deploy Stably's infrastructure. A workflow file that first appears in a push is
registered as active and starts at once, so every push the sync workflow and `pod-stack.sh --push`
make is followed by `scripts/pod-workflow-quarantine.sh`. It disables every workflow Pod does not
own and cancels their unfinished runs. If you push to `main` or `orca-main` any other way, run it
yourself. Pod's own workflows are `upstream-sync.yml` and files named `pod-*.yml`; name new ones that way.

## Maintainers: the sync token

The sync workflow needs a repository secret named `POD_SYNC_TOKEN`. The built-in `GITHUB_TOKEN`
cannot push commits that change `.github/workflows`, and Orca's `main` changes them constantly.

- Fine-grained token: resource owner `outof-place`, repository `outof-place/pod` only, with
  Contents, Pull requests, Issues and Workflows set to read and write.
- Or a classic token with the `repo` and `workflow` scopes.
- Store it with `gh secret set POD_SYNC_TOKEN -R outof-place/pod`.

Without it, the workflow keeps Orca's workflows disabled, then fails and says why.

## Maintainers: the macOS build runner

The sync workflow builds on the standard `macos-15` runner: 3 M1 cores, free for public
repositories. If `pnpm build` runs out of memory there, set the `POD_MAC_RUNNER` repository variable:

- `macos-15-xlarge`: 5 M2 cores and 14 GB of memory. Larger runners are billed per minute even on
  public repositories, so this needs a payment method on the `outof-place` organization.
- A self-hosted Mac: give it a label of its own, for example `pod-mac`, and set the variable to that
  label. Self-hosted runners cost nothing on GitHub's side. This workflow runs only on schedule and
  on demand, never on pull requests, so code from forks never reaches the machine.

```sh
gh variable set POD_MAC_RUNNER -R outof-place/pod -b macos-15-xlarge
```

Delete the variable to go back to `macos-15`.
