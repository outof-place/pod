# Pod benchmarks

Reproducible measurements of where Pod (this fork of Orca) is faster than official Orca and other
terminals, and where it is not. The suite also covers claude-acc, which ships inside Pod.

Every number in the Pod README comes from a file under `results/<date>/`, produced by the scripts
in this directory, and committed on the `pod/bench` branch. Nothing is estimated or extrapolated.
A metric not measured under the rules below is listed as pending, not guessed. A claude-acc number
measured before this suite existed is labelled historical, with its date and source.

## Machine and conditions

- MacBook Pro 16" (Mac16,5): Apple M4 Max, 16 CPU cores (12 performance + 4 efficiency), 48 GB.
- macOS 27 (the exact build is recorded in every result file).
- AC power, Low Power Mode off. Each result file records the power source.
- Built-in Liquid Retina XDR display at 120 Hz.
- All subjects run on the same machine, one at a time, in rotating order. That way warm-up and
  thermal drift do not favour one subject.
- **Load gate.** Other agents share this Mac. Each sample starts only when the 1-minute load
  average is at or below 8 (`POD_BENCH_MAX_LOAD`). Each sample records:
  - the load average before and after it;
  - how many cores the whole machine kept busy during it (`hostBusyCores`).

  A sample is never taken above the gate, so nothing needs to be re-run afterwards. A suite that
  cannot get a quiet machine within an hour stops; it does not record anything.

- **Statistics.** Each benchmark runs at least 5 times. The tables report:
  - the median: the average of the middle pair when n is even;
  - the nearest-rank p95;
  - n.

  This is the definition in `config/scripts/benchmark-sample-summary.mjs`. Raw per-sample values
  are in the result files.

## Subjects and versions

Each suite records the exact versions it measured in `versions` (app bundle version, build id,
commit and signing team for Orca and Pod). It also records the tool versions (git, ripgrep,
Playwright).

| Subject                       | What it is                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orca                          | Official Orca, latest release (1.4.223 on 2026-10-09), `/Applications/Orca.app`, signed by Stably (6CX3WHS9HZ)                                                                                              |
| Pod (native Ghostty terminal) | The assembled Pod `main`, built and Developer ID signed by `product/release.sh` (bundle `codes.pod.app`, CLI `podx`), with `experimentalNativeTerminal` on. `run-final.sh --pod` names the build explicitly |
| Pod (xterm.js)                | The same Pod build with the setting off: it separates the native terminal's effect from the rest of the build                                                                                               |
| Ghostty                       | Ghostty 1.3.1 (latest release), visible-window suites only                                                                                                                                                  |

VS Code, Cursor, Zed, Warp and iTerm2 are not installed on the benchmark Mac, so they are not
compared. Neither are Conductor and Claude Squad. Terminal.app is not either: driving it takes
AppleScript against the user's own running Terminal, by name, which a run never does.

## Isolation: how Orca and Pod are launched

The benchmark never touches the user's own Orca or its profile (`~/Library/Application
Support/orca`). Every Orca or Pod instance gets:

- a throwaway profile under `~/Library/Application Support/orca-native/bench/`, set through
  `ORCA_E2E_USER_DATA_DIR`, the only userData override packaged builds honour, plus an isolated
  `HOME` (`lib/orca-instance.mjs`).

  Electron's single-instance lock is per profile, so these instances never meet the running Orca.

- a windowless launch: `ORCA_E2E_HEADLESS=1 ORCA_BACKGROUND_LAUNCH=1`. That means no window, no
  Dock tile and no activation (`src/main/window/foreground-activation-policy.ts`).
- background throttling off on every window, plus Chromium's backgrounding switches off, as
  `tests/e2e/native-terminal-ghostty-perf.spec.ts` does, so a hidden window keeps rendering.
- the E2E suite's completed-onboarding profile, so no first-run overlay covers a terminal pane.
  Telemetry is off, and the mock keychain is used.
- a hermetic shell: the panes run `/bin/zsh` with a `ZDOTDIR` whose `.zshrc` only sets `PS1="%# "`
  and logs each prompt's time. Orca's zsh wrapper restores `ZDOTDIR`, so no pane reads the user's
  own shell config.
- control through the instance's own CLI (`orca`, or `podx` in Pod), pointed at its profile with
  `ORCA_USER_DATA_PATH` and `POD_USER_DATA_PATH` (Pod's name since `pod/decouple`): `repo add`,
  `terminal create --focus`, `terminal split` and `terminal send`.
- cleanup afterwards: every process whose argv names the profile is killed (the terminal daemon
  and its shells), and the profile is deleted.
- `POD_ACC_LIFECYCLE=off` in every launch's environment, the app's and its CLI's. When it starts,
  the packaged Pod installs claude-acc by running the bundled `setup.sh`
  (`src/main/pod/acc/acc-lifecycle.ts`). That script reloads launchd jobs in the user's real
  `gui/<uid>` domain, whatever `HOME` is, so an isolated profile does not contain it. `off` skips
  it, and a launch without that value refuses to start.

`lib/acc-guard.mjs` then proves the user's claude-acc install was not touched:

- At the start of a run it records three things: the `com.filip.claude-acc*` plists (mtime and
  size), `~/.local/share/claude-acc/owner.json`, and every loaded `com.filip.claude-acc*` job's
  plist path, program and arguments.
- It compares against that record after each app launch, after each close and after each suite.
  The comparison covers the loaded jobs because a `setup.sh` under a temporary `HOME` would load
  that `HOME`'s plists and leave the real files' mtimes unchanged.
- While an instance runs, it polls once a second for a claude-acc `setup.sh` process.
- Any change, or any such process, stops the run at once (exit 70). The instances are killed and
  the reason is written to `acc-guard-tripped.raw`.
- `node --test bench/lib/acc-guard.test.mjs` covers it.

## Benchmarks

### 1. Keystroke-to-pixels latency (`suites/latency.mjs`, `latency/keylat.swift`)

`keylat` measures every app the same way:

1. It posts the key `x` to the app's pid (`CGEventPostToPid`) and timestamps it with
   `mach_absolute_time`.
2. It watches a 360x48 pt region at the prompt with ScreenCaptureKit, at the display's refresh
   rate (120 Hz).
3. It records the display time of the first frame whose pixels differ from the frame before the
   key.
4. It erases the glyph with Delete, waits until the region is still, and repeats after a random
   20–60 ms pause, so keys do not lock to the display's refresh.

The echo comes from zsh's line editor in the same hermetic shell in every app, and cursor blink
is off everywhere. The resolution is one frame (8.3 ms at 120 Hz). With 200 keys per subject at a
random phase, the median is not biased by it.

This needs a visible, focused window, so it only runs with `--confirm-visible`, in a slot when
nobody else uses the Mac. Without that flag it runs only the dry run: permission preflight and the
detector's self-test. See [Running without taking the desktop](#running-without-taking-the-desktop).

### 2. Terminal throughput (`suites/throughput.mjs`, `tools/termload.c`)

Inside a focused pane, `termload` runs one workload and then sends a primary device-attributes
query (`CSI c`). It stops the clock when the reply arrives: a terminal answers only after it has
parsed every byte written before the query, which is the vtebench method.

**What the reply proves.** The reply marks parse completion by whichever emulator owns query
replies, not paint:

- In Orca that is xterm.js in the renderer.
- In Pod's native panes (with renderer parse-once) it is the main process's headless emulator,
  neither xterm.js nor the Ghostty view.

Paint has two measures of its own. `settle` is the time until the app's CPU is back at idle, which
includes drawing. The visible run's keystroke-to-pixels time comes from ScreenCaptureKit. The reply
string is recorded with every sample, so a result file shows which emulator answered.

The workloads:

- `seq 1 3000000`: 22.9 MB of short lines;
- `cat` of a deterministic 100 MiB colored log, generated by `lib/terminal-workloads.mjs` (its
  sha256 is recorded);
- a TUI repaint flood: 10,000 full 80x24 frames with 256-color SGR on the alternate screen.

Per workload:

- `wall`: from the producer's start to the reply.
- `settle`: until the app's processes are back at their idle CPU rate.
- `app CPU`: CPU time of main, renderer, GPU, terminal daemon and helpers over that window. The
  shell and the workload itself are excluded.

The pane is at the instance's default window size (1728x1083 pt). The grid it got (`cols`x`rows`)
is recorded, and a sample whose pane was not laid out yet does not count.

Ghostty has no windowless mode. It runs the same workloads in a visible 1100x700 pt window, with
`latency.mjs --confirm-visible --throughput`, in the visible slot, from an APFS clone in the
profile (its processes are found and stopped by that executable, never by argv), opened with
`open -n -g` under `env -i` (the profile's `HOME` and `TMPDIR`, a system `PATH`, the session's
`SSH_AUTH_SOCK`, `USER`, `LOGNAME` and `DISPLAY` empty). The clone gets a bundle id of its own,
`codes.pod.bench.ghostty`, and an ad hoc signature (no hardened runtime): cfprefsd keys a
preferences domain by bundle id and account, never by `HOME`, so the clone writes to its own
domain, never the account's Ghostty one. Its config sets `auto-update = off`, so Sparkle neither
checks nor prompts. Both results record the account's Ghostty domain (the plist's sha256 and
mtime, `defaults export`'s sha256, a hash of the saved state's listing of names, sizes and mtimes)
before the first round and after the last, also when a round fails, and name what changed. They
also count the processes of the account's own Ghostty at both ends: one running meanwhile can
change its domain without the bench. The clone's own domain is a known trace: when the run created it
(it didn't exist before the first round), the suite runs `defaults delete codes.pod.bench.ghostty`
after the last round, then moves the plist and saved state left on disk to the Trash, and the
results show the domain before and after. A domain that existed before the run is left alone and
reported. Orca and Pod run
there too, so the visible numbers compare all four with painting included. Those results go to
`throughput-visible.json`.

How the command gets into each terminal:

- Orca and Pod: `orca terminal send`;
- Ghostty: a queue file that a loop in its window runs, because Ghostty cannot be typed into from
  outside.

### 3. Startup to an interactive terminal (`suites/startup.mjs`)

This is the time from spawning the app to the first shell prompt in the restored workspace's
terminal pane, taken from the hermetic zsh's prompt log. Each subject gets one profile whose saved
session holds one focused terminal tab, made by a real launch that quits cleanly.

- **cold**: Chromium's caches are deleted first: Cache, Code Cache, GPUCache, DawnGraphiteCache,
  DawnWebGPUCache, Shared Dictionary and blob_storage.
- **warm**: a relaunch right after a launch that rebuilt them.

Apps are spawned directly, with no automation attached, and quit with SIGTERM, which Orca handles
as a normal quit. The OS file cache is not purged, because `purge` would slow every other process
on the machine.

### 4. Memory and idle CPU with 1 and 8 panes (`suites/panes.mjs`)

The suite starts with one pane and then splits it into a 4x2 grid of 8, with every pane at an idle
prompt. For each layout it waits 10 s to settle, then measures over a 10 s window:

- phys_footprint (Activity Monitor's "Memory") and RSS, summed over the app's processes, from
  `proc_pid_rusage`;
- idle CPU (CPU ms per second).

The app's processes are main, renderer, GPU, utility helpers and the terminal daemon. The shells
are excluded. Default settings, so cursor blink is on.

### 5. Code search for agents (`suites/search.mjs`)

**The repo.** Every search suite reads one Portivo checkout: a fresh local clone of the Portivo
mirror `~/.local/share/portivo-repo` (about 18.6k files). `search/prepare.sh` makes it, and its
SHA is recorded. The suites never write to it. The user's working checkout changes all the time,
so it is not used.

`suites/search.mjs` runs 24 fixed queries: literals and regexes an agent would grep for, listed in
the script. Each query runs as its own process, first one at a time and then all 24 at once. The
second case is a fleet of agents searching in parallel, and the result is the time until all 24
finish. The OS file cache is warm, because a warm-up round runs first. Every engine must give the
same number of matching lines per query, and any disagreement is recorded. The engines:

- ripgrep (`--no-config`);
- `og`: pod-search's ripgrep 15.2.0 fork, with the same arguments and output. It answers from
  ogd's index when it can, and execs the real `rg` when it cannot. The suite starts its own `ogd`
  (its own socket and state dir) and waits for `ogctl register --wait`. It records `ogctl status`
  at the end, then stops it. Three details keep the comparison clean:
  - **Fallback.** og's fallback is pinned to Homebrew's ripgrep 15.2.0 (`OG_REAL_RG`). og writes
    every call's decision, served from the index or fallen back, to `OG_DECISION_FILE`. Each sample
    records both counts, and any fallback becomes a caveat on the og rows. The suite stops if
    that rg is not exactly 15.2.0, since og would then fall back on every call. A run in which
    og served no call from the index is broken: its og rows are left out and a caveat says so.
  - **Eviction.** The daemon runs with a one-day idle limit, so a long wait at the load gate
    cannot evict the index between samples.
  - **Index build.** The cold index build (`build_ms` from `ogctl status`) is a row of its own,
    `search.og-index-build`, kept out of the search timings.

`suites/ogd.mjs` measures Pod's indexed search (ogd) against ripgrep through the two harnesses on
`pod/search-client`, each run 5 times, gated on load:

- **Engine level** (`src/main/pod/search/ogd-ripgrep-parity.real-ogd.test.ts`): 8 text queries and
  2 file listings, each through ogd and through Orca's bundled ripgrep. That rg is what Orca users
  get; og forks rg 15.2.0. Each value is the median of 5 runs, and every result is diffed, so a
  timing run is also a correctness check. ogd clips lines over 1 MiB, and Pod's client then
  declines its reply and asks rg. A query whose answer had a clipped line (the report's
  `fallbacks`) keeps both rows with a caveat but gets no comparison, since in Pod it takes rg's
  time.
- **In app** (`tests/e2e/pod-native-search.spec.ts`): headless Pod UI. It times quick open and
  text search from the request to the first result row, on rg and on ogd, with gitignored files
  shown and hidden. Its text queries use the parity test's options, so the same run's
  `fallbacks` show which ones Pod answered from rg; those have no in-app ogd row.

Both harnesses register the repo with ogd and wait for the index before timing starts, so indexing
time is not in the numbers. `search/prepare.sh` builds the binaries from a pinned pod-search SHA,
in their own clone and through claude-acc's build scheduler, as pod-search's README does:

- `cargo fetch --locked` in both workspaces, then the builds run with `--offline`;
- `cargo build --release --offline --locked -p ogd -p ogctl`;
- og in `third_party/ripgrep` with `cargo build --release --offline --locked --features pcre2`.

The harnesses come from a pinned `pod/search-client` worktree. All
three SHAs are in `run.json` and in the ogd suite's `versions`.

### 6. Source Control status poll (`suites/git-status.mjs`)

This compares, with `GIT_OPTIONAL_LOCKS=0` as Orca polls:

- Orca 1.4.223's poll: `git status --porcelain=v2 --branch --untracked-files=all`;
- Pod's poll ([stablyai/orca#26979](https://github.com/stablyai/orca/pull/26979), branch
  `perf/git-status-untracked-cache`): `--untracked-files=normal`, plus one
  `git ls-files --others --exclude-standard` scoped to the collapsed `? dir/` rows.

Each sample checks that both return the same set of untracked paths. The repo's fsmonitor and
untracked-cache settings are recorded.

Git's untracked cache keeps the mode that last wrote it. So before each sample a plain
`git status` (optional locks on) puts it in normal mode. That is the state terminals and agents
keep it in, and one in which Orca's `all` poll cannot use the cache.

### 7. Process polling (`suites/polling.mjs`, `tools/ttyprobe.c`)

These are the process reads Orca makes all the time. Each is done Orca 1.4.223's way, by forking
`/bin/ps` (from C, and with `execFile` from Node as Orca does), and by reading the kernel's
process table with sysctl:

- the whole process table, which Orca's daemon reads about once a second (`PS_ARGS` in
  `src/shared/process-table-snapshot.ts`):
  - `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=`;
  - vs `KERN_PROC_ALL` plus `KERN_PROCARGS2` per process, with `devname` cached per device. The
    `tty=` column is what makes `ps` slow: it runs `devname`, a scan of /dev, for every row.
- the terminal lookup behind "who holds this pane's terminal"
  (`src/main/runtime/terminal-foreground-group.ts`): `ps -o tty= -p PID` vs `KERN_PROC_PID` plus
  `devname`;
- that terminal's process rows: `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t TTY` vs
  `KERN_PROC_TTY` plus `KERN_PROCARGS2`.

`ps`'s cost depends on the machine:

- **Process and pty counts.** The `tty=` column runs one /dev scan per tty-bearing row, so its
  cost follows the number of open terminals. Every sample records how many processes there are
  and how many sit on a tty.
- **Column variants.** The suite also times `ps -axo` without `tty=`, with `tty=` only, and with
  `pid=` only, to show where the time goes.
- **An agent fleet's ptys.** In the quiet window the agents are parked and few ptys are open.
  `polling.mjs --extra-ptys 80` repeats every measurement with 80 idle ptys added, as an agent
  fleet keeps open, in a suite of its own (`polling-ptys80`).

  Each polling suite says which state it stands for, in `condition` and in its caveat:
  - `quiet`: the window with the agents parked;
  - `agent-heavy`: the 80 extra ptys. This one matches daily use.

The C sysctl versions are a reference implementation in `tools/ttyprobe.c`. What Pod ships is its
process-info addon ([stablyai/orca#26985](https://github.com/stablyai/orca/pull/26985)). The suite
loads it from the Pod build under test (`Contents/Resources/native/orca-proc-info.node`) and
measures `listProcesses`, `readProcess` and `listTerminalProcesses`, recording its sha256. The
target is a pty holding a shell with two children.

### 8. claude-acc (`suites/claude-acc.mjs`, `claude-acc/historical.json`)

claude-acc ships inside Pod. Its numbers come in two kinds, and summary.json tells them apart with
`provenance.kind`:

- **historical**: measured before this suite existed and published in claude-acc's README. Each
  row has the date and the commit that added the number. A range in the source stays a range:
  `min` and `max`, no median. A number that was only ever written down in private notes is never a
  source, so it is either re-measured fresh or left out. `historical.json` lists what was left out
  and why: general Mac tuning, the user's own hooks, unpublished numbers, and items with no
  measured number.
- **fresh**: re-measured in the final run with `--fresh`. Each one reproduces "before" without
  touching the user's live settings:

| Fresh measurement | Before                                                           | After                                                                                            |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `compile-cache`   | `require('typescript')`, NODE_COMPILE_CACHE unset                | the same with a temporary cache dir                                                              |
| `rg-threads`      | `rg` with its default threads on Portivo                         | `rg --threads=4`                                                                                 |
| `guard-hook`      | `devguard.py admit` on a PreToolUse payload for `ls -la`         | `claude-acc-hook`, the native hook                                                               |
| `launcher-python` | `/usr/bin/python3 -I -c pass`                                    | claude-acc's uv Python                                                                           |
| `git-speed`       | `git status` in a temporary clone of Portivo, caches off         | the same clone with untrackedCache and fsmonitor                                                 |
| `compress`        | copies of the user's transcripts in a temporary dir              | after `afsctool -c -T LZFSE`, as the janitor runs it                                             |
| `compress-apps`   | decompressed copies of user-owned app bundles from /Applications | after `afsctool -c -T LZFSE`, as the janitor runs it                                             |
| `devtools`        | a fresh Go binary's first exec, started by a launchd job         | the same, started from the run's own app (in Developer Tools)                                    |
| `sched`           | 7 Go builds behind a mkdir lock, as the old plock                | the same through `sched.py` in a temporary HOME                                                  |
| `hook-wait`       | (none)                                                           | the hook wait per tool call in the last 24 h of transcripts, from `claude-acc perf bench agents` |

### 9. Browser commands for agents (`suites/browser.mjs`)

These are the commands an agent sends through `orca browser …` or `podx browser …`: snapshot,
click, fill, get title and screenshot. There is also a row for the first click after a navigation.

- **What is timed.** Each command is the runtime RPC request the CLI sends (`lib/runtime-rpc.mjs`),
  one connection per call, timed from connect to reply. The app answers it through agent-browser
  on a local page in the worktree's browser tab. The page has 200 rows of buttons and links. The
  CLI's own process start is not part of the time.
- **Effect checks.** Every call is checked for its effect:
  - a click has to be counted by the page;
  - a fill has to leave its value in the input;
  - a snapshot has to reach the last row;
  - the title has to match;
  - a screenshot has to be over 4 KiB.

  A call that did not act is not timed. It is counted in `extra.acted`, and a caveat names the
  command.

- **Navigation.** `goto` answers before the new document exists, because it does not go through
  agent-browser. So the "first click after a navigation" row waits until a new document has
  loaded. The row's `extra.immediateClickLanded` counts how often a click sent the moment `goto`
  answers still reached the new page.
- **Runs.** The default is 20 rounds over 2 launches per app, in alternating order. The first round
  of each launch warms agent-browser up and is not kept. Both apps are windowless, with background
  throttling off.

### 10. Claude Code hooks (`suites/hooks.mjs`, `tools/hookrun.c`)

Both apps install command hooks into Claude Code's settings, so that every session event (a
prompt, each tool call before and after, a stop, a sub-agent) reaches the app. Claude runs the
hook as a new process for each event. This suite measures what one event costs with the hook
each app installs.

- **Which hook.** Each app's own bundled installer writes it (`lib/hook-install.cjs` loads the
  hook-service chunk from the app's `app.asar`), into a throwaway `HOME`, for the version of the
  installed `claude`, read from its install path. `claude` itself never runs. The suite records
  the plan, the form and the command each app wrote.
  - Orca writes a shell-form command: Claude runs it through `/bin/sh -c`, and it runs
    `/bin/sh ~/.orca/agent-hooks/claude-hook.sh`, which posts with `curl`.
  - Pod writes an exec-form `pod-agent-hook` (`args: []`), a C client with no shell, and marks
    the status-only events `async`.
- **Payloads.** The events are hook payloads Claude Code wrote over a real PTY, from the fixtures
  both repos carry in `src/shared/__fixtures__/` (the blobs are pinned in the suite). Recorded
  events that neither app installs a hook for are left out, since Claude would run none for them.
- **How an event runs.** `tools/hookrun.c` spawns the command as Claude does: exec form directly,
  shell form as `/bin/sh -c`. It writes the payload to stdin and closes it, then reads stdout and
  stderr to EOF and reaps the process. Events run one at a time, 25 ms apart.
- **Receiver.** Both apps post to one loopback stub. It reads the body and answers 204, as the
  runtime's hook server does, through the endpoint file and pane env the runtime publishes. Every
  event has to arrive once, with the right token, as the raw payload, or the suite stops. The
  runtime's handling of a post is not in these rows.
- **Metrics, per event:**
  - `cpu`: user and system CPU of the hook's whole process tree, read from the top process
    after it exits and before it is reaped (its own time plus its reaped descendants'), plus
    any process that outlived it;
  - `processes`: the tree's processes, counted through kqueue from a suspended start. This is a
    lower bound, since a grandchild can exit unseen. `extra.pidSpanMin`, the smallest gap
    between consecutive hook pids, bounds it from above (other processes take pids too);
  - `wall`: spawn to exit and stdout EOF, how long the hook process lives;
  - `blocking`: the part of `wall` Claude waits for, as a mean per event per replay. It is 0 for
    an event whose hook is installed `async`, since Claude does not wait for those.
- **Runs.** The default is 6 replays of all events per app, alternating which app goes first.
  A first pair is a discarded warmup.

### 11. Idle cost with the native UI (`suites/native-idle.mjs`)

This suite measures what Pod 1.0 costs while nothing happens: CPU (ms/s), wakeups/s and
memory (`phys_footprint`). It counts PodNative, its runtime with the runtime's helpers, and
the terminal daemon. The terminals' shells are not counted. It runs on its own, not from
`run-final.sh`:

```sh
POD_BENCH_POD_APP=<re-id'd copy of Pod.app> node bench/suites/native-idle.mjs [--launches 2] [--window-s 300]
```

- **States.** One launch goes through them in order:
  - no terminal;
  - 1 idle terminal;
  - 8 idle terminals;
  - the 8 closed again through Close Terminals (`worktree.sleep`).

  Each state gets a window (300 s by default), after a 60 s warmup at the start and 30 s to
  settle after each change.
- **Window mode.** PodNative runs as `--background`. Its window is laid out and drawn, but never
  ordered in, so nothing shows on screen. That is neither a visible window nor a closed one: git
  and the tab snapshots treat it as on screen, the status bar as hidden. The rows say so.
- **Variants.** Each variant gets its own launches, in ABBA order.
  - `acc-on` is the default config. It reads a claude-acc state, here a stub one: PodNative's
    mac-e2e fixtures, rewritten at claude-acc's live rates by their writer.
  - `acc-off` (`POD_NATIVE_NO_ACC=1`) is the breakdown without it.
- **Isolation.** Each launch gets:
  - an APFS clone of the re-id'd bundle, with a fresh profile and `HOME`;
  - PodNative's `app_open` (`scripts/open-app.sh` at the guard's revision): `open -n -g -W` under
    `env -i` with an allowlist (`HOME`, the guard `PATH`, a short `TMPDIR`, `SHELL`, `LANG`,
    `GUARD_POSITIVE_MARK=1`), the launchd session's `SSH_AUTH_SOCK`, `USER`, `LOGNAME` and
    `DISPLAY` empty, then the bench's `--env`. The runtime gets the same blanks, `SHELL`, `TMPDIR`
    and `LANG` through `--runtime-env`, and the mark only through its environment;
  - the guard `PATH` (`lib/guard-path.mjs`, PodNative's `scripts/guard-path.sh` at a pinned
    revision): a stub for every agent and credential CLI the app's catalog probes, first in every
    shell of the profile's `HOME`, with the gate-2 `security` shim in front. After the launch,
    every PATH a stub logged must have had the stubs first, and no `claude` may have run past
    `--version`, or the launch fails;
  - the canary: the shell that runs `app_open` has `GUARD_CANARY_TOKEN` set. Once the runtime is up
    and again with 8 terminals, PodNative and its runtime must show `GUARD_POSITIVE_MARK` and no
    canary (`guard_env_pid_check`, names only, never a value), and no other process of the launch
    may show the canary; the stubs' log of their environment's names must show the mark and never
    the canary. A process that shows neither (zsh and other platform binaries, whose environment
    `ps -E` doesn't show) is listed as unproven in the result.

  A watchdog stops the launch on any real `claude` or `codex` in the run's tree, or on a new
  SecurityAgent. Before the first launch the suite refuses to start if the launchd session sets
  `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, a userData override, `NODE_OPTIONS` or
  `DYLD_INSERT_LIBRARIES`, which an app started through LaunchServices would get. After each
  launch it checks three things: that the account's Claude files have the same content
  (`lib/real-home-guard.mjs`), that the shim saw only `find` calls, and that claude-acc's install
  is unchanged (`lib/acc-guard.mjs`).
- **Deep links.** While a launch runs, its clone is registered with LaunchServices (until
  `lsregister -u` at its cleanup), so a `pod://` link clicked meanwhile could open in it. Don't
  click Pod links during a run.
- **Cleanup.** Only processes whose executable lies inside the run's dir get a signal, and so do
  their descendants. A process that merely names the dir in its argv (anyone's `tail` of a log
  there) is reported, never signalled (`lib/run-tree.mjs`, tested in `lib/run-tree.test.mjs`). Each launch's result lists every signal sent.
- **Sampling.** `tools/procstat.c` reads every process of the launch at each window's edges.
  That means every process whose executable lies inside the run's dir (the clone's PodNative and
  runtime helpers, plus the daemon the runtime copies into the profile) and their descendants. `extra.breakdown` splits the numbers by process class. A window counts only when
  the load gate held at its start. PodNative's own `--measure` report is kept next to them as a
  cross-check.

## Running without taking the desktop

Two questions decide whether the visible-window latency run can happen while someone uses the
Mac:

- **Virtual display: works for visibility.** CoreGraphics' private `CGVirtualDisplay` API, the one
  DeskPad uses, is present on macOS 27: `.build/bin/vdisplay --probe`. `vdisplay --create` adds a
  120 Hz HiDPI virtual monitor that windows can be moved to, and ScreenCaptureKit can capture it.
  Creating one moves the user's display layout, so the final run skips it. Only
  `run-final.sh --vdisplay` runs it, as a 20 s check that writes `vdisplay.json`. The finding
  stays at the API level: present and probed, never created on this Mac.
- **Keyboard input: does not work without focus.** `keylat --probe-post` posts a key with
  `CGEventPostToPid` to its own window in an inactive, Dock-less process. The window cannot become
  key, and the key never arrives. AppKit routes keys only to the key window of the active app.

  So whether a terminal sits on the virtual display or not, it must be the active app to receive
  typed keys, and that takes keyboard focus from the user. The latency run therefore needs a slot
  in which nobody else is using the Mac.

## Reproduce

The final run is one command. It takes about 70 minutes on a quiet Mac, plus the search builds of
step 1. With `--visible` it adds about 20 minutes that take the desktop and keyboard focus; that
part is a step of its own in the user's GO, never the default:

```sh
bench/run-final.sh --pod /path/to/Pod.app --pod-commit <main SHA> \
  --og-sha <pod-search SHA> --search-client-sha <pod/search-client SHA>
```

`--og-sha` is the pod-search commit confirmed as bench-ready, never a branch or `HEAD`. Its ogd
must advertise `search.full_lines` and `search.max_filesize`; `run-final.sh` checks the built
binary for both and stops before anything is measured. Without `--og-sha`, the og and ogd rows
appear in `summary.json` under `coming`, with no numbers. Without `--search-client-sha`, only the
ogd rows do.

The steps, in order:

1. `search/prepare.sh` pins and builds the search inputs. These builds are not measured.
   `run.json` records the Pod build, its commit and those inputs.
1. `suites/preflight.mjs`: every subject launches and gives one synced terminal workload.
1. polling (also with 80 extra ptys), git-status, search, ogd, startup, panes, throughput and browser.
1. `claude-acc.mjs --fresh`.
1. Only with `--visible`: the virtual display check (also only with `--vdisplay`), then
   `latency.mjs --confirm-visible --throughput`.
1. `summarize.mjs` and the Markdown tables.

Without `--visible` the run never needs the desktop.

### One-app Pod (1.0 and later)

Pod 1.0 is a native app (PodNative, bundle `codes.pod.native`) with Pod's Electron runtime nested
at `Contents/Helpers/Pod Runtime.app`. `--pod` takes the one-app bundle; the suites resolve it to
the runtime and record the outer app's version and `PodNativeRevision` under `versions.*.oneApp`.
The suites drive the runtime's Electron UI, which Pod 1.0 does not show, so for a 1.0 build run:

```sh
bench/run-final.sh --pod <copy of Pod.app> --pod-commit <main SHA> --orca <copy of Orca.app> --runtime-only
```

`--runtime-only` keeps the rows that do not depend on the runtime's Electron UI: polling (process
reads the runtime makes for every user) and browser (the runtime started on its own, in classic
mode with a hidden window, not the headless mode Pod 1.0 starts it in; the rows say so). It lists
startup, panes, throughput, the visible run, git-status and search under `coming`: native UI rows
pending a PodNative driver, git-status pending a suite that replays the status strategy Pod 1.0
runs, and search because without og it is plain ripgrep, not Pod code. It refuses `--visible`
and skips claude-acc. A visible launch of a one-app runtime is refused: in the
foreground the runtime opens its outer PodNative through LaunchServices, outside the bench's env.

Every run keeps its profiles under one `/private/tmp/pod-bench.XXXXXX` dir, printed at the start.
Nothing is deleted while the run goes on (cold starts move the caches aside); remove the dir with
`pod-tmp-rm` afterwards. Before the first
CLI call, `status` must report the instance's own runtime id, or the run stops before any change.
Every launch gets the guard `PATH` (`lib/guard-path.mjs`, PodNative's `scripts/guard-path.sh` at a
pinned revision): a stub for every agent and credential CLI in the app's catalog (the dev
checkout's source or the package), first in the profile's `HOME` and `ZDOTDIR` shells. The app
starts only through the helper's `guard_exec`: `env -i` with an allowlist (the profile's `HOME`,
the guard `PATH`, a `TMPDIR` of at most 48 bytes in the run dir, `SHELL=/bin/zsh`, `LANG`,
`GUARD_POSITIVE_MARK=1`, then the bench's own variables), nothing of the caller's environment. The
bench sets `GUARD_CANARY_TOKEN` in its own environment first. While the instance runs, its main
process must show the mark and no canary (`guard_env_pid_check`, names only), and no other process
of its tree may show the canary. A bench started from inside a Pod terminal refuses
(`pod-terminal-guard.sh`). Closing the instance fails the run when a stub was reached off that
PATH, `claude` ran past `--version`, or a stub call carried the canary or no stub call showed the
mark. The `guard_exec` step (a bash and a Python check) runs between the spawn and the app's exec,
so startup rows include it. Cleanup
signals only the processes the run spawned (pinned by start time), those whose executable lies in
the profile, and an app copy's own process that names the profile (crashpad); anything else that
names the profile is reported and left alone.
Pod's terminals start without the macOS `/usr/bin/login` wrapper (`ORCA_DISABLE_MACOS_LOGIN_SHELL=1`),
which keeps each shell inside its throwaway `HOME`. Run the apps from copies (`cp -c`) outside
`/Applications`, so the published bundle stays untouched.

Pieces on their own:

```sh
bench/run.sh throughput                       # builds the tools, runs one headless suite, writes summary.json
node bench/suites/claude-acc.mjs              # only the historical claude-acc rows
node bench/report.mjs bench/results/<date>/summary.json   # Markdown tables
```

Requirements:

- Xcode command line tools (clang, swiftc);
- Node 24;
- `pnpm install` in this checkout, for playwright-core and tsx. Alternatively, set
  `POD_BENCH_CHECKOUT` to a checkout that has them;
- for the latency run: Screen Recording and Accessibility permission for the terminal that runs
  it.

Overrides:

- `POD_BENCH_POD_APP`: the Pod build;
- `POD_BENCH_ORCA_APP`;
- `POD_BENCH_MAX_LOAD`;
- `POD_BENCH_OUT`: the results directory.

## Result files

`results/<date>/<suite>.json` (UTC date of the run). Each file has:

- the machine;
- the versions and the config;
- every sample, with its load average and busy cores;
- the headline `metrics`.

They are committed on `pod/bench` together with `summary.json`.

Both are written for publication, with two safeguards:

- **Paths.** Every string has the user's home directory replaced by `~`.
- **Sources.** `summarize.mjs` refuses to write a summary in which a row's source or note cites a
  private note or a local path.

<a id="summaryjson"></a>

### summary.json

`summarize.mjs` writes it (`schemaVersion` 2). Top level:

| Field                    | What it holds                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `hardware`, `machine`    | model, chip, cores, memory, macOS build, power source                                                            |
| `methodology`            | this file's path and URL                                                                                         |
| `maxLoad`, `aggregation` | the load gate; median = average of the middle pair, p95 = nearest rank                                           |
| `run`                    | `run.json`: the Pod build, the main commit and build profile it came from, the search inputs' SHAs               |
| `podStack`               | `pod-stack.json` at that Pod commit (`origin/main` without run.json): the topic branches the benched Pod carries |
| `caveats`                | caveats that apply to every row, including differing Electron versions and Pod's slim build profile              |
| `groups`                 | `pod` (Pod vs Orca and other terminals) and `claude-acc`                                                         |
| `suites.<name>`          | file, versions, config, `condition` (polling: `quiet` or `agent-heavy`, else null) and suite-wide caveats        |
| `coming`                 | rows this run could not measure yet: `id`, `suite`, `subject`, `reason`, `status` `"coming"`; never a number     |

Each `metrics[]` row has these fields:

| Field                                 | What it holds                                                             |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `id`, `suite`, `group`                | e.g. `throughput.cat.wall.pod-native`, `throughput`, `pod`                |
| `subject`, `metric`, `unit`, `better` | `better` is `lower` or `higher`                                           |
| `n`, `median`, `p95`, `min`, `max`    | `n` and `median` are null when the source gave only a range               |
| `extra`                               | secondary numbers (settle time, RSS, p90, notes)                          |
| `conditions`                          | how it was measured                                                       |
| `provenance`                          | `{ kind: "fresh" \| "historical", date, source, note }`                   |
| `branch`, `upstream`, `inPodStack`    | where a change comes from, and whether the benched Pod's stack carries it |
| `podCommit`                           | on every `pod` group row: the main commit of the Pod build it measured    |
| `caveats`                             | strings to print with the number                                          |

`comparisons[]` rows have:

- `baseline` and `candidate` (`{ id, subject, median }`);
- `factor`: above 1, the candidate is ahead by that factor; below 1, it is behind;
- `candidateAhead`, `label`, `provenance` and `caveats`.
