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
| Terminal.app                  | The macOS 27 Terminal, visible-window suites only                                                                                                                                                           |

VS Code, Cursor, Zed, Warp and iTerm2 are not installed on the benchmark Mac, so they are not
compared. Neither are Conductor and Claude Squad.

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
  `ORCA_USER_DATA_PATH`: `repo add`, `terminal create --focus`, `terminal split` and
  `terminal send`.
- cleanup afterwards: every process whose argv names the profile is killed (the terminal daemon
  and its shells), and the profile is deleted.

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

Ghostty and Terminal.app have no windowless mode. They run the same workloads in visible
1100x700 pt windows, with `latency.mjs --confirm-visible --throughput`, in the visible slot. Orca
and Pod run there too, so the visible numbers compare all five apps with painting included. Those
results go to `throughput-visible.json`.

How the command gets into each terminal:

- Orca and Pod: `orca terminal send`;
- Terminal.app: AppleScript `do script`;
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

This runs on Portivo (`~/Documents/portivo-app/Untitled`, about 18.7k tracked files), with 24
fixed queries: literals and regexes an agent would grep for, listed in the script. Each query runs
as its own process, first one at a time and then all 24 at once. The second case is a fleet of
agents searching in parallel: the result is the time until all 24 finish.

The OS file cache is warm, because a warm-up round runs first. Every engine must give the same
number of matching lines per query, and any disagreement is recorded. The engines:

- ripgrep 15.2.0 (`--no-config`);
- `og` from pod-search, once it has a runnable CLI.

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

The C sysctl versions are a reference implementation in `tools/ttyprobe.c`. What Pod ships is its
process-info addon ([stablyai/orca#26985](https://github.com/stablyai/orca/pull/26985)). The suite
loads it from the Pod build under test (`Contents/Resources/native/orca-proc-info.node`) and
measures `listProcesses`, `readProcess` and `listTerminalProcesses`, recording its sha256. The
target is a pty holding a shell with two children.

### 8. claude-acc (`suites/claude-acc.mjs`, `claude-acc/historical.json`)

claude-acc ships inside Pod. Its numbers come in two kinds, and summary.json tells them apart with
`provenance.kind`:

- **historical**: measured before this suite existed, copied as written from claude-acc's README
  or the project notes, with the date, the source and the commit that added it. A range in the
  source stays a range: `min` and `max`, no median. `historical.json` also lists what was left out
  and why: general Mac tuning, the user's own hooks, and items with no measured number.
- **fresh**: re-measured in the final run with `--fresh`. Each one reproduces "before" without
  touching the user's live settings:

| Fresh measurement | Before                                                   | After                                                                                            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `compile-cache`   | `require('typescript')`, NODE_COMPILE_CACHE unset        | the same with a temporary cache dir                                                              |
| `rg-threads`      | `rg` with its default threads on Portivo                 | `rg --threads=4`                                                                                 |
| `guard-hook`      | `devguard.py admit` on a PreToolUse payload for `ls -la` | `claude-acc-hook`, the native hook                                                               |
| `launcher-python` | `/usr/bin/python3 -I -c pass`                            | claude-acc's uv Python                                                                           |
| `git-speed`       | `git status` in a temporary clone of Portivo, caches off | the same clone with untrackedCache and fsmonitor                                                 |
| `compress`        | copies of the user's transcripts in a temporary dir      | after `afsctool -c -T LZFSE`, as the janitor runs it                                             |
| `devtools`        | a fresh Go binary's first exec, started by a launchd job | the same, started from the run's own app (in Developer Tools)                                    |
| `sched`           | 7 Go builds behind a mkdir lock, as the old plock        | the same through `sched.py` in a temporary HOME                                                  |
| `hook-wait`       | (none)                                                   | the hook wait per tool call in the last 24 h of transcripts, from `claude-acc perf bench agents` |

## Running without taking the desktop

Two questions decide whether the visible-window latency run can happen while someone uses the
Mac:

- **Virtual display: works for visibility.** CoreGraphics' private `CGVirtualDisplay` API, the one
  DeskPad uses, is present on macOS 27: `.build/bin/vdisplay --probe`. `vdisplay --create` adds a
  120 Hz HiDPI virtual monitor that windows can be moved to, and ScreenCaptureKit can capture it.
  Creating one reconfigures the display arrangement, which the user sees. So it runs only in the
  final window, as a 20 s check that writes `vdisplay.json`.
- **Keyboard input: does not work without focus.** `keylat --probe-post` posts a key with
  `CGEventPostToPid` to its own window in an inactive, Dock-less process. The window cannot become
  key, and the key never arrives. AppKit routes keys only to the key window of the active app.

  So whether a terminal sits on the virtual display or not, it must be the active app to receive
  typed keys, and that takes keyboard focus from the user. The latency run therefore needs a slot
  in which nobody else is using the Mac.

## Reproduce

The final run is one command. It takes about 70 minutes on a quiet Mac, and its last 20 minutes
take the desktop and keyboard focus:

```sh
bench/run-final.sh --pod /path/to/Pod.app     # preflight, every suite, claude-acc --fresh, vdisplay, visible run, summary
```

The steps, in order:

1. `suites/preflight.mjs`: every subject launches and gives one synced terminal workload.
2. polling, git-status, search, startup, panes and throughput.
3. `claude-acc.mjs --fresh`.
4. The virtual display check.
5. `latency.mjs --confirm-visible --throughput`.
6. `summarize.mjs` and the Markdown tables.

`--no-visible` stops before the desktop is needed.

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

<a id="summaryjson"></a>

### summary.json

`summarize.mjs` writes it (`schemaVersion` 2). Top level:

| Field                    | What it holds                                                                  |
| ------------------------ | ------------------------------------------------------------------------------ |
| `hardware`, `machine`    | model, chip, cores, memory, macOS build, power source                          |
| `methodology`            | this file's path and URL                                                       |
| `maxLoad`, `aggregation` | the load gate; median = average of the middle pair, p95 = nearest rank         |
| `podStack`               | `origin/main:pod-stack.json` at summary time: which topic branches Pod carries |
| `caveats`                | caveats that apply to every row                                                |
| `groups`                 | `pod` (Pod vs Orca and other terminals) and `claude-acc`                       |
| `suites.<name>`          | file, versions, config and suite-wide caveats                                  |

Each `metrics[]` row has these fields:

| Field                                 | What it holds                                                 |
| ------------------------------------- | ------------------------------------------------------------- |
| `id`, `suite`, `group`                | e.g. `throughput.cat.wall.pod-native`, `throughput`, `pod`    |
| `subject`, `metric`, `unit`, `better` | `better` is `lower` or `higher`                               |
| `n`, `median`, `p95`, `min`, `max`    | `n` and `median` are null when the source gave only a range   |
| `extra`                               | secondary numbers (settle time, RSS, p90, notes)              |
| `conditions`                          | how it was measured                                           |
| `provenance`                          | `{ kind: "fresh" \| "historical", date, source, note }`       |
| `branch`, `upstream`, `inPodStack`    | where a change comes from, and whether Pod's stack carries it |
| `caveats`                             | strings to print with the number                              |

`comparisons[]` rows have:

- `baseline` and `candidate` (`{ id, subject, median }`);
- `factor`: above 1, the candidate is ahead by that factor; below 1, it is behind;
- `candidateAhead`, `label`, `provenance` and `caveats`.
