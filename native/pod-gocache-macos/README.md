# pod-gocache

Pod's Go build cache, in two parts that share Go's own GOCACHE directory and format.

- The GOCACHEPROG client: `go` starts it, asks it for cached outputs and hands it new ones, and it keeps them in the very same GOCACHE directory, in the same format, that the built-in cache uses. A go command with `GOCACHEPROG="<path> prog"` reads entries the built-in cache wrote and writes entries the built-in cache reads. Rolling back means unsetting GOCACHEPROG.
- The daemon (Phase A): a per-user launchd agent that owns the cache directory. It keeps it within 45 GB, gives space back when the disk runs low, never deletes what a running build could still read, stops Go's own five-day trim, and publishes `owner.json` so older trimmers stand down. It starts read-only (observe mode). Later stages add pins, deduplicated compiles and metrics. The client never needs the daemon.

`bench/` is a separate module with the S0 measurements; nothing here imports it.

## Build

```sh
cd native/pod-gocache-macos
CGO_ENABLED=0 go build -ldflags "-X main.version=<version>" -o pod-gocache ./cmd/pod-gocache
```

`go.mod` pins `toolchain go1.27.2`. No GOEXPERIMENT, no dependencies outside the standard library. Without `-X main.version` the version is `0.0.0-dev`.

## Command line (frozen)

| Command | Behavior |
|---|---|
| `pod-gocache prog` | The GOCACHEPROG client, for `GOCACHEPROG="<path> prog"`. Speaks the protocol on stdin and stdout until `go` sends `close` or its stdin ends, then exits 0. |
| `pod-gocache daemon [--cache-dir <abs>] [--state-dir <abs>] [--mode observe] [--live-dir <abs>\|off]` | The cache daemon, normally started by launchd. See [Daemon](#daemon) and [Shared state](#shared-state-s9). |
| `pod-gocache status [--json] [--state-dir <abs>]` | The daemon's last status, read from the state directory, so it works with the daemon down. `--json` prints `state.json` plus `heartbeatFresh` and `stale` and exits 0; it exits 74 only when `state.json` exists but can't be read or parsed. When no daemon ever ran it prints `{"version":"<version>","mode":"standalone","neverRan":true,"heartbeatFresh":false,"stale":false}`. Without `--json` it prints the same in words. `-json` is accepted as an alias of `--json`. `version` and `mode` are always present. |
| `pod-gocache version` | Prints the bare version on one line, exit 0. |

Anything else prints usage to stderr and exits 64 (EX_USAGE). New flags, if any, will be optional.

## Environment

| Variable or file | Effect |
|---|---|
| `GOCACHE` | The store. `go` sets it to its effective value (absolute) for every subprocess (`cmd/go/main.go`, `envcmd.MkEnv`), so the client never runs `go env`. Unset, the client uses go's default, `os.UserCacheDir()/go-build`. `off`, a relative path, invalid UTF-8 or a path near PATH_MAX leaves the client without a store: gets miss and puts fail. `go` itself refuses to start in those cases, so this only matters when the client is run by hand. |
| `POD_GOCACHE_TRACE_DIR` | Where the access trace goes. Default `~/.pod/gocache/trace`. |
| `POD_GOCACHE_TRACE=off` | No trace. |
| `POD_GOCACHE_LIVE_DIR` | Root of the state the daemon shares with clients ([Shared state](#shared-state-s9)). Default `~/Library/Caches/pod-gocache/live`. A relative value leaves the client without shared state. |
| `POD_GOCACHE_LIVE=off` | The client ignores the shared state and works as S1 did: every get reads the `-a` file. |
| `~/.pod/gocache/disabled` | Kill switch, checked once at start. When the file exists the client writes no trace and never opens the shared state: it is a plain native-layout disk cache. This is the rollback for terminals whose environment already holds GOCACHEPROG. |

Beyond the frozen contract, the client also has: `POD_GOCACHE_TRACE=off` and `POD_GOCACHE_TRACE_DIR` (above), the plain-words `status` and the `-json` alias, the unknown-command error reply, and bucket directories re-created on a put when a cleanup removed them.

## What the client guarantees to go

- The capabilities line (`{"ID":0,"KnownCommands":["get","put","close"]}`) is the first thing it does, before it looks at the store. `go` waits for it with no deadline.
- It never exits on its own before `close` or the end of stdin (`go` treats an early exit as fatal). `go list` ends without `close`; the client treats the end of stdin as a normal close. Garbage on stdin is skipped line by line.
- It ignores SIGINT and SIGQUIT, like `go` does, so Ctrl-C lets `go` finish and close it. SIGPIPE is ignored too: when `go` is gone, a failed write ends the session quietly.
- It writes nothing to stderr.
- A get never fails: anything unexpected is a miss.
- A put error is reported as the built-in cache reports it (`open <GOCACHE>/xx/<hex>-d: permission denied`, `write ...: no space left on device`), so `go` prints the same message with or without the client. `go` ignores put errors except where the built-in cache's errors stop it too: `go list -export`, `go list -test`, the module index, PGO preprocessing and the read-your-writes check after a put (`exec.go:851`).
- A command it does not know gets an error reply with the request's ID (the capabilities line only announces `get`, `put` and `close`, so `go` never sends one).
- Requests are answered in arrival order. Responses are buffered and written before the client blocks on a read, so a burst of gets costs one write.

## Store format guarantee

The store is the GOCACHE directory in Go's native layout (Go 1.27.2 `cmd/go/internal/cache/cache.go`), byte for byte:

- `<GOCACHE>/<xx>/<hex action ID>-a`: one line, `v1 <hex id> <hex output id> <size, %20d> <unix nanoseconds, %20d>\n`.
- `<GOCACHE>/<xx>/<hex output ID>-d`: the output, named by its SHA-256.
- `<xx>` is the first byte of the ID in hex.

How the client reads:

- A hit reads the `-a` line with one open and read, checks it exactly as `(*DiskCache).get` does, and stats the `-d` file; a missing or wrong-size output is a miss.
- The time in the response is the time stored in the `-a` line, the original put time. `go test` compares it with `go clean -testcache`'s cutoff.
- Like the built-in `markUsed`, a hit sets the mtime of the `-a` and `-d` files to now when it is more than an hour old. Without that, the built-in daily trim in other go processes, and any mtime-based cleanup, would delete entries the client serves all day.
- A `-d` that is a directory holding one file is an executable the built-in cache stored for `go run` or `go tool`; the hit is that file. The client never writes such entries (cmd/go stores executables only through `*DiskCache`).

How the client writes:

1. If the `-d` file exists with the right size and its SHA-256 matches, the body is skipped and the file reused. A size match alone is not trusted: the built-in cache fills `-d` in place, so a right-sized file can be half written.
2. Otherwise the body is decoded and written with pwrite into `<GOCACHE>/<xx>/.pgc-tmp.<pid>.<seq>`, hashed while it arrives, and renamed to `-d` only when the hash equals the output ID. No process ever sees a partial `-d`.
3. Then the `-a` line is written in place, truncating after the write, as `putIndexEntry` does.
4. No fsync, as in the built-in cache.

On a failed put (disk full, permissions, a body that does not match its ID) the temp file is removed, nothing new is left, and `go` gets the error. A bucket directory a cleanup removed is created again.

The client only reads and writes bucket directories, their `-a` and `-d` files and its own `.pgc-tmp.*` files. It never touches `fuzz/`, `trim.txt`, `README`, `testexpire.txt` or `log.txt`, never deletes an entry, and does not run Go's trim. Only a client killed with SIGKILL in the middle of a put can leave a `.pgc-tmp.*` file; built-in trims ignore those names, so the daemon will sweep them. A client or `go` killed between creating and writing an `-a` file can leave it empty, exactly as the built-in cache can; go reads that as a miss.

## Access trace

Every session writes its own file, `<trace dir>/<unix nanoseconds of the session start, 20 digits>-<pid>.pgtrace`, so a short write (a full disk) can only tear the end of that one file. A session whose file reaches 8 MiB continues in a new file named with the time of the switch. When a session ends or switches files it deletes the least recently written files until the directory holds at most 64 MiB; files other sessions are still appending to have the newest mtimes and go last. Records are buffered in memory (about 64 KiB) and written off the request path by a background goroutine, and at session end after stdout is closed so `go` never waits for them; `Close` waits at most 2 s for a stuck disk. If the writer falls behind, records are dropped rather than held up; a write or open failure turns tracing off for the session and never affects a build.

Each record is 40 bytes, little-endian, and a file is a plain sequence of records with no header (format version 1, unchanged). `ReadDir` ignores a partial record at the end of a file, skips records of an unknown version, and returns all files' records ordered by time.

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | time, unix nanoseconds: the session's wall-clock start plus monotonic time since |
| 8 | 8 | first 8 bytes of the action ID (as a big-endian integer), 0 for session records |
| 16 | 8 | first 8 bytes of the output ID, 0 when unknown (misses) |
| 24 | 8 | body size in bytes |
| 32 | 4 | client pid |
| 36 | 2 | microseconds spent serving the request, saturating at 65535 |
| 38 | 1 | op: 1 start, 2 get hit, 3 get miss, 4 put stored, 5 put of an existing output, 6 put failed, 7 close, 8 end of input without close, 9 get hit served from the shared index, 10 the session's use of the shared state |
| 39 | 1 | format version, 1 |

A session writes one op 10 record when it ends. Its three fields carry: at offset 8, the index reason (byte 0), the pins reason (byte 1), 1 in byte 2 when the pin log filled up, and from bit 32 the puts that rewrote an output the daemon was deleting; at offset 16, fast hits (low 32 bits) and hits that read the `-a` file (high 32 bits); at offset 24, lookups that found the index stale (low) and hits turned into misses because the output was being deleted (high). Reasons are numbered 0 ok, 1 no-root, 2 no-cache, 3 missing, 4 invalid, 5 denied, 6 no-slot, 7 fault, 8 error, 9 off ([Shared state](#shared-state-s9)). Ops 9 and 10 are new in S9 within version 1: an S1 reader skips them as unknown records.

`internal/trace.ReadDir` decodes a trace directory.

## Daemon

### Flags and files

| Flag | Default | Meaning |
|---|---|---|
| `--cache-dir <abs>` | `os.UserCacheDir()/go-build` | The GOCACHE directory to own. Pod's plist passes `go env GOCACHE`. A relative path exits 64. Symlinks in it are resolved once at start, and the resolved path is what the daemon manages and publishes. A missing directory is fine: the daemon stays up, creates nothing and reports `waiting-for-cache-dir` until go creates it (a path that only becomes a symlink later is not followed). |
| `--state-dir <abs>` | `~/.pod/gocache` | Where the mode file, the lock, `owner.json`, `state.json`, the crash-loop record and `daemon.log` live. Tests and manual observe runs pass a temp dir. |
| `--mode observe` | none | Read-only whatever the mode file says. No other value is accepted: owner mode is switched by the mode file only. |

Files in the state directory:

| File | Written by | Meaning |
|---|---|---|
| `mode` | Pod or a person | `owner` (trimmed) asks for owner mode. Missing, `observe`, empty, any other content, a directory, a symlink or a FIFO means observe; the reason shows in status. The daemon reads at most 65 bytes and never blocks. Once a valid file has been read, content that stays invalid for under a second is ignored, so `echo owner > mode` (which truncates before it writes) never flips an owner daemon to observe. |
| `owner.json` | daemon | The heartbeat other trimmers obey (schema below). |
| `state.json` | daemon | Full status (schema below). |
| `daemon.lock` | daemon | flock plus the holder's pid. A second daemon on the same state directory exits 0 within a second with one stderr line naming the holder. |
| `starts` | daemon | Unclean starts in the last 10 minutes, for the crash-loop breaker. |
| `daemon.log`, `daemon.log.1` | launchd and daemon | stderr. When `daemon.log` passes 1 MiB the daemon renames it to `daemon.log.1` and reopens stderr itself, because launchd keeps the descriptor open. |

### Modes

The daemon starts in observe mode: it indexes the cache, plans, and publishes what it would delete (`wouldEvictBytes`), and writes nothing into the cache directory. In owner mode it deletes entries, rewrites `trim.txt` and sweeps the client's temp files. Three things cap owner mode at observe:

- `--mode observe`.
- Test settings (window under 30 minutes or budget under 1 GB) on `os.UserCacheDir()/go-build`.
- Another daemon holding the flock on the cache directory's own file descriptor, which writes nothing into it. Two daemons with different state directories on one cache therefore never both delete.

Switching to owner writes `trim.txt` at once. Switching to observe stops removals and `trim.txt` rewrites in the cycle that notices it, and `owner.json` says `observe` in that same cycle. A clean stop (SIGTERM), the crash-loop breaker and a startup error also write `owner.json` with `observe`, so the old trimmers resume at once instead of 120 seconds later.

### What it deletes, and when

The daemon only ever removes `<cache>/<xx>/<64 hex>-a` and `-d` regular files, the one file inside an executable `-d` directory (what `go run` and `go tool` store) and that emptied directory, plus the client's `<xx>/.pgc-tmp.<pid>.<seq>` files. It never follows a symlink, never removes a bucket directory, and never touches `README`, `fuzz/`, `testexpire.txt`, `log.txt` or any other name. Those count as unmanaged bytes in status: odd names inside buckets on every relist, and everything at the root besides the buckets (with `fuzz/` apart) in a walk every 15 minutes. The budget applies to managed entries only, and a status line splits what `du` shows into the two. The only file it ever creates in the cache directory is `trim.txt`.

Recency is an entry's mtime (an `-a`), the newer of mtime and atime (an output), and for an executable the newest of the directory, its file and its `-a`. Ages are awake time: a sleep or a forward clock step does not age entries. The credit survives a daemon restart, including a sleep that happened while no daemon ran (the daemon stores its wall clock, the system's awake clock and `kern.boottime` in `state.json`). A reboot carries no credit, since no go process survives one: when `kern.boottime` moved by more than a minute, earlier credits are dropped and the gap counts in full. A clock stepped back makes entries look younger, never older.

Free disk sets the tier. A tier is entered below its threshold and left only 1 GB above it.

| Free disk | Tier | Target | Window | Speed |
|---|---|---|---|---|
| 15 GB or more | normal | 45 GB | W | throttled thread |
| under 15 GB | low-disk | shrink toward 15 GB free, not below a 15 GB cache | W | throttled thread |
| under 10 GB | hard-floor | the same; the 30 minute window only until free is back at 11 GB | 30 min | full |
| under 7 GB | emergency | the same; the 15 minute window only until free is back at 8 GB | 15 min | full |

W is 2 hours, widened by the oldest go-family process: `max(2 h, min(age, 6 h) + 65 min)`. Go refreshes an entry's mtime only when it is an hour old, and a build reads what it looked up for its whole life, so W covers both. The family is `go`, `compile`, `link`, `asm`, `cgo`, `vet`, `golangci-lint`, `gopls` and `*.test`, read from `sysctl kern.proc.all`. The kernel cuts names to 16 bytes; such a name is read back whole with `KERN_PROCARGS2` (so `com.microsoft.teams2.agent` is not taken for a test binary), and one that can't be read (another user's process) counts as a test binary when its cut ends in `.t`, `.te` or `.tes`. `gopls` (it lives as long as the editor; the `go list` it runs counts on its own) and a `go` process whose only children are other programs (a `go run` serving, a `go tool` running) count as at most 30 minutes old. A process still counts for 45 minutes after it exits, because tools that ran `go list -export` read the export data after it; across a handover (below) the stopped run's W stands in for the exited processes it still counted. The hard-floor and emergency tiers ignore processes. Unreadable process table: W is the maximum, 7 h 5 min.

Other rules:

- Index: the first pass lists every bucket and reads every `-a` (about 15 s of CPU for 100k files). After that the daemon polls the 256 bucket directories every 30 seconds (5 seconds below 15 GB free) and reads only new names, and re-stats every entry once per 15 minutes (30 seconds below 15 GB free) to see Go's hourly mtime refreshes. Every tick's scanning stops after 2 seconds and resumes on the next tick, however slow the disk is under load. No kqueue: polling measured 70 times cheaper on a busy cache.
- Start grace: no deletions for 2 hours after start while free disk is at least 15 GB, or unknown (statfs failing). Below 15 GB there is none, and none after a reboot since the last `state.json` (`kern.boottime` moved by more than a minute): no go process survives a reboot, so there is nothing the grace could protect. The grace belongs to the ownership episode, not the process: after a handover only the remainder carries over, the awake time of grace the stopped run had left (`extra.graceLeftNs` in its last `state.json`, counted whatever free disk was then) less the gap, so a reinstall 30 minutes after a first start keeps the grace for the other 90 minutes, and a handover from a run past its grace has none.
- Handover: what a Pod update or a reinstall does (launchd's SIGTERM, then the new helper seconds later). A handover is a `state.json` showing a clean stop (`extra.phase` `stopped`) of a daemon whose mode file asked for owner (`extra.modeRequested`), on the same cache and the same boot, with at most 2 minutes of wall clock between its last write (`extra.lastWallNs`) and this start; a negative gap is none. For 45 minutes of awake time after a handover, W in the normal and low-disk tiers is at least the stopped run's `extra.windowSeconds`, capped at 7 h 5 min, so the exited go processes that run still counted keep counting. The log has one `handover from pid` line with the grace carried, and `extra.reasons` says so while the carried W holds. A crash or SIGKILL, the crash-loop breaker, an observe run, another cache, a reboot, a longer gap or no `state.json` give a full start grace.
- Order (`age-buckets-v2`): oldest idle bucket first (over 5 days 1 hour, which is what Go's own trim would delete; over 1 day; over 6 hours; over 1 hour; over 30 minutes; over 15 minutes; and W itself, wherever it falls, so no bucket mixes entries inside and outside W), largest first within a bucket. Bytes freed by entries older than W count toward the relaxed tiers' need first, so a relaxed window frees only what is still missing.
- Low-disk episode cap: from the moment free disk drops under 15 GB until it is back at 16 GB, eviction for disk (bytes below the 45 GB budget) stays within an allowance, passed by one entry at most. Each tick the allowance becomes the larger of itself and the live deficit to 15 GB free plus the bytes of chunks confirmed to have freed disk. Removals that free nothing confirm nothing, so eviction stays within the largest deficit seen, however free disk swings across a tier line. Removals that free disk keep up with whatever else eats it (Docker, simulators, `$TMPDIR`), down to the 15 GB cache floor above 10 GB free. Getting down to the 30 GB budget is not capped, since it does not depend on free disk.
- Chunks and no effect: eviction for disk is judged in chunks. A full chunk is 2 GB; the daemon then waits 5 seconds. A smaller one is judged once eviction has stopped for 5 seconds and no output is queued. A chunk counts as confirmed when free disk rose by at least half of it (after what go wrote meanwhile). A full chunk under 10% logs `no effect: evicted X GB, free disk +Y` and pauses eviction for disk until free disk responds or 10 minutes pass. Free disk falling into a lower tier lifts that pause, once per tier per episode. Free disk crossing a tier line in either direction voids the measurement in progress, since someone else freeing disk at that moment could pass for the chunk's effect.
- Each removal: an `-a` goes first, after its output's recency is checked on disk again. The output follows at least 5 seconds later, after a relist, only if no `-a` references it any more and it is still idle; its atime is lowered in the meantime so any read shows up as use. Every unlink is a fresh lstat plus inode and recency check, so an entry a build revived since the plan stays.
- Executables: `-a`, then the file inside, then the empty directory. A killed daemon can leave an empty directory but never one whose `-a` still exists.
- Client temp files: removed when their pid is dead and they are over 10 minutes old, or when they are over 2 hours old. Reported apart from evictions (`extra.clientTempSwept`).
- Timestamps more than 6 hours in the future are reset to now once, so Go's hourly refresh and the window work on them again.
- A removal refused by permissions or flags is logged once, counted as `stuckBytes` and retried after an hour.
- Go's own trim: `trim.txt` holds the current time in unix seconds, written under Go's flock every 6 hours, after a clock jump and on switching to owner. Go skips its trim when that time is less than a day old. A lock Go holds for a read is retried on the next tick. If `trim.txt` cannot be written (or stays locked for a minute), status says `Go trim not suppressed` and the daemon retries after 10 minutes.
- Priority: scanning and removal run on one OS thread lowered with `PRIO_DARWIN_BG`; the hard-floor and emergency tiers run at normal priority, and every `owner.json` write steps out of the background band for its duration. The loop also leaves the band while it is behind: the first index still incomplete after 15 ticks (about 30 seconds), the last removal batch cut short with work left, or the cache over budget with removals planned. It logs `loop behind (...)`, says so in `extra.reasons`, and returns to the band (`loop caught up`) once none holds.
- Crash-loop breaker: the fifth unclean start within 10 minutes logs one line, writes `state.json` with the error, and exits 0, so launchd's `KeepAlive {SuccessfulExit: false}` stops restarting it. Pod's next launch starts it again.

### owner.json (frozen)

```json
{"schema": 1, "version": "1.0.0", "pid": 4242, "startedAt": 1792250000, "heartbeatAt": 1792253600,
 "mode": "owner", "cacheDir": "/Users/me/Library/Caches/go-build", "budgetBytes": 45000000000, "targetBytes": 45000000000}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | 1 |
| `version` | string | The daemon's version. |
| `pid` | integer | The daemon's pid. |
| `startedAt`, `heartbeatAt` | integer | Unix seconds. |
| `mode` | string | `owner` or `observe`. |
| `cacheDir` | string | Absolute and cleaned (no trailing slash). |
| `budgetBytes` | integer | 45 GB. |
| `targetBytes` | integer or null | The size the daemon steers toward; null until the first full index. |

The daemon writes `owner.json` atomically (temp file, fsync, rename) in its first cycle, before it indexes, and then every 30 seconds from the loop's own progress: a hook on every file system call writes it when it is due, at normal priority, so a long scan or batch on a throttled disk keeps it fresh and a wedged loop stops it. It is rewritten in the first cycle after a sleep or a clock jump, and with `mode: observe` on a clean stop.

Reader rule: a trimmer stands down only if `schema == 1`, `mode == "owner"`, `|now - heartbeatAt| <= 120` seconds and `cacheDir` equals the reader's own cache directory after resolving symlinks on both. Anything else (no file, unparseable, observe, stale, another directory) means no owner: trim as before. Shell: `[ $(( $(date +%s) - hb )) -le 120 ]` works because the times are integers; `plutil -extract heartbeatAt raw -o - owner.json` reads them too.

### state.json

Fields outside `extra` are fixed; `extra` may gain fields and never renames one. `sizeBytes`, `entries`, `targetBytes`, `wouldEvictBytes` and `oldestRecencyAt` are null until the first full index (and `freeDiskBytes` while statfs fails), so a size of 0 is never published while indexing. `status` calls a daemon stale when its heartbeat is older than 120 seconds or its phase is `stopped`, `crash-loop` or `error`.

| Field | Meaning |
|---|---|
| `version`, `mode`, `cacheDir` | As in `owner.json`. |
| `sizeBytes`, `entries` | Allocated bytes and count of managed files. |
| `budgetBytes`, `targetBytes` | Budget and current target. |
| `freeDiskBytes` | Last sample (every 2 seconds). |
| `wouldEvictBytes` | What the current plan removes. In observe mode this is what owner mode would delete from the same state. |
| `evictions` | `{count, bytes, lastAt}` since start. |
| `oldestRecencyAt` | Unix seconds of the least recently used entry. |
| `heartbeatAt` | Unix seconds. |
| `extra.phase` | `waiting-for-cache-dir`, `indexing`, `ready`, `stopped`, `error` or `crash-loop`. |
| `extra.reasons` | Plain sentences explaining the state: observe and why, start grace and its end, a handover and the window it carries until when, the window and the process behind it, `cannot keep up` with the bytes protected, the episode cap and its allowance, a no-effect pause, stuck and future-dated bytes, what `du` shows split into managed and never-touched bytes, bytes deleted by something else, `Go trim not suppressed`, and after a stop the time it stopped. |
| `extra.error` | A startup error or the crash-loop message. |
| `extra.tier`, `extra.windowSeconds`, `extra.windowReason`, `extra.graceUntil` | Tier, W in seconds, what widened it (a process, or the window a handover carries), end of the start grace (absent after a reboot, or after a handover from a run past its grace). |
| `extra.graceLeftNs` | Awake nanoseconds of start grace left at this write, whatever free disk is; what a handover carries over. |
| `extra.protectedBytes`, `extra.evictableBytes`, `extra.stuckBytes`, `extra.futureBytes` | Where the managed bytes are. |
| `extra.unmanagedBytes`, `extra.unmanagedFiles` | Odd names inside buckets. |
| `extra.rootUnmanagedBytes`, `extra.rootUnmanagedFiles`, `extra.fuzzBytes` | Everything at the root besides the buckets, and the `fuzz/` part of it (last walk). |
| `extra.vanishedBytes`, `extra.vanishedLastAt` | Entries deleted by something other than this daemon since it started (`go clean`, Go's own trim, an old trimmer). In owner mode a growing number means a trimmer did not stand down. |
| `extra.clientTempBytes`, `extra.clientTempSwept` | Client temp files present, and `{count, bytes, lastAt}` swept. |
| `extra.episode` | The low-disk episode: evicted, allowance, confirmed, room left, no-effect pause. |
| `extra.restarts` | Unclean starts in the last 10 minutes before this one. |
| `extra.trimWrittenAt`, `extra.trimError` | Last `trim.txt` write. |
| `extra.scan`, `extra.cpuSeconds`, `extra.maxRssBytes` | File system calls since start, own CPU time and peak RSS. |
| `extra.policy` | `age-buckets-v2`. |
| `extra.live` | The shared state: `dir`, `reason` (why nothing is shared now), `entries` and `slots` of the index, `refused` entries, live `clients`, `pinningProcesses`, `pinningPids` (`pid`, `goPid` and `pins` of up to 32 live clients holding pins), `overflowedClients`, `overflowHoldSince` and `overflowKept` (below), `pinnedBytes`, `pinnedOverCapBytes`, `pinnedGaveWayBytes`, `pinnedKept` (removals skipped for a pin since start), `records` read from client logs, `rereads` of `-a` files clients flagged, `dyingBatches`, `sessions` (`fastHits`, `diskHits`, `misses` and `puts` summed over the live sessions and those that ended since start, and `indexReasons`: sessions by why they went without the index, `ok` when they used it; clients report every 32 requests and at exit), `repairs` and `lastRepair` (shared files recreated after they were deleted or replaced, with when and what), `clientsFiles` (mapped clients files, 2 while clients of a replaced one still live). |
| `extra.sleepCredits`, `extra.lastWallNs`, `extra.lastAwakeNs`, `extra.bootTimeUs` | Internal: how the next start learns about sleeps and reboots. |

### Exit codes

0 on SIGTERM or SIGINT, for a duplicate daemon, and when the crash-loop breaker trips. 64 for a bad flag or a relative path. 74 when the state directory can't be created. 78 for other configuration errors (no HOME and no flags). A Go panic exits 2, which launchd restarts and the breaker counts. Every non-zero exit after the state directory is known leaves its reason in `state.json`.

### launchd priority keys

Phase A: `ProcessType` `Standard`, and no `LowPriorityIO` and no `Nice`. Standard applies launchd's light CPU and I/O limits to background work, and the daemon lowers its own scanning thread further. `LowPriorityIO`, `Nice` or `ProcessType Background` act on the whole process, so they would also slow eviction below 10 GB free and the heartbeat writes that must stay fresh under load.

Phase B, when the daemon answers gets on the build's hot path over a socket: `ProcessType` `Interactive`, still no `LowPriorityIO` and no `Nice`, with eviction kept on its `PRIO_DARWIN_BG` thread. Standard's light throttling would land on every cache hit. `Adaptive` follows XPC transactions only and does not apply to a plain socket. Measure get latency under load with Standard and Interactive before shipping it.

### Decisions

- The budget is 45 GB, not 30 (18.10): on the author's Mac about 44 GB sits inside the 2 hour window at peak, so 30 GB was never reachable and status kept saying `cannot keep up`. Small disks stay protected by the low-disk tier (shrink toward 15 GB free, not below a 15 GB cache), which is unchanged.
- Low-disk allowance (amended D4): `allowance = max(allowance, live deficit to 15 GB free + bytes of confirmed chunks)`, with a lower tier lifting a no-effect pause at most once per tier per episode. The first rule (the deficit at the episode's start, measured again on every tier drop) wiped a 30 GB cache when removals freed nothing and free disk swung across a tier line, and froze at 0.1 GB while something outside the cache ate 6.6 GB. Confirmation needs half the chunk back, so other writers' noise neither confirms nor pauses; a smaller chunk that shows nothing is simply not counted. A tier change during a measurement voids it: free disk is one number, and a large outside rise at the moment a chunk settles would otherwise be credited to the chunk (seen in DST: a 4.6 GB outside rise during a snapshot confirmed a 4.5 GB chunk that freed nothing). An outside rise of at least half a chunk that stays within one tier can still be credited; each such coincidence widens the allowance by at most one chunk.
- An output goes 5 seconds after its last `-a`, not W later. The `-a` removal already proved nobody used the pair within W; in the 5 seconds a go process can reach the output only through a new `-a`, which the relist before removal sees, or by reading it, which the armed atime (set just below mtime, so APFS bumps it on the next read) shows. An output whose atime is already past its mtime is not armed: lowering it would erase read evidence a wider window may need, so that output relies on the relist and the recency recheck at unlink.
- `targetBytes` in `owner.json` and six `state.json` fields (`sizeBytes`, `entries`, `targetBytes`, `wouldEvictBytes`, `oldestRecencyAt`, `freeDiskBytes`) are null until the first full index (`freeDiskBytes` while statfs fails), so no reader mistakes an empty index for an empty cache. Trimmers following the reader rule never read them.
- A clean stop writes `owner.json` with `observe` rather than letting it go stale. The old trimmers resume at once; a quick restart (a Pod update) then gets no 120 second grace, and the stopped run's window, carried by the handover, covers the cache instead.
- Scans are bounded by time (2 seconds a tick), not by bucket count, and `owner.json` is written from a hook on every file system call when due, at normal priority: under load one tick of 16 buckets ran past 10 seconds, so a bucket count could not keep the heartbeat under the 120 second reader limit.
- Hard floor 10 GB and emergency 7 GB (first 8 and 6): Docker, Postgres and every session's tests fail around 5 GB free on this Mac (11.10 and 17.10), and swap shares the volume and grew 5 GB in 5 minutes on 17.10. Between 15 and 10 GB only entries idle longer than W go, which on a busy day is little (on 17.10 29 of 30.6 GB were used within 2 hours), so the shorter windows have to start with that much margin left.
- `gopls` counts as at most 30 minutes old, like `go run`: it lives as long as the editor, and the `go list` it starts is a family process of its own.
- W is always an age-bucket bound (`age-buckets-v2`), so a relaxed tier never takes an entry inside W while entries outside it are left.
- No sleep credit across a reboot (`kern.boottime` moved), and the start grace holds while free disk is unknown.
- No start grace after a reboot since the last `state.json` (18.10: after a reboot the cache grew from 32 to 43 GB in 70 minutes of grace while entries from before the reboot were evictable). The window and the process-aware window still protect what go processes started since the boot use.
- Only the rest of the start grace after a handover (18.10: a restart at 14:45 blocked trimming until 16:45 with the cache at 48 GB, and free disk fell from 35 to 17 GB while e2e runs refuse under 30 GiB; every Pod update would do the same). The grace stands in for state a fresh daemon lacks, and after a clean stop seconds earlier the only piece lost is the process tracker's memory of go processes that exited within 45 minutes. The carried W replaces it. It is the W the stopped run published and stays there: the tracker would have kept aging an exited process, so W would have grown by up to 45 minutes more, and an entry such a process looked up early in its life, with an mtime Go's hourly refresh skipped, may go that much sooner. It counts awake time like the start grace, and it leaves the hard-floor and emergency windows alone, since those ignore processes anyway. The 2 minute gap allows launchd's bootout and bootstrap with room to spare; anything longer, or a crash, gives a full grace, because then go processes may have run and exited while no daemon watched. A handover from a run still in its grace (a first start after install or a crash, then a reinstall within 2 hours) keeps what was left of it: the builds the first run could not see have not shown their use yet, and a restart does not change that.
- The loop leaves the background band while it is behind (18.10, S9 NOTICED 1: at load 60 to 130 a background thread left a small cache unindexed for 3 minutes, stopped slowly and missed its eviction slots). It goes back once caught up, so on a calm day scanning still yields to builds.

## Shared state (S9)

The daemon publishes what it knows about the cache in two memory-mapped files, and the client reads them without asking the daemon anything. A get then costs a hash lookup and one stat of the `-a` file instead of an open, read and close, and every output a go process was handed stays on disk until that process exits. Nothing depends on it: a client with no shared state, or with broken files, works exactly as S1 did.

### Where the files are

`<root>/v1-<dev>-<ino>/`, where `<dev>` and `<ino>` (hex) identify the cache directory itself. Every spelling of one cache (a symlink, a trailing slash) finds the same files, and no other cache ever does.

| Process | Root |
|---|---|
| daemon | `--live-dir`, else `$POD_GOCACHE_LIVE_DIR`, else `<state-dir>/live` when `--state-dir` is not the default, else `~/Library/Caches/pod-gocache/live` |
| client | `$POD_GOCACHE_LIVE_DIR`, else `~/Library/Caches/pod-gocache/live` |

`~/Library/Caches` is left out of Time Machine backups. `--live-dir off` turns publishing off. The daemon creates the directories `0700` and the files `0600`. A client never creates, renames or truncates anything there, and opens only regular files of its own user with no group or other permission bits, with `O_NOFOLLOW` and `O_NONBLOCK`, so a symlink can't redirect it and a FIFO can't block it.

| File | Size | Written by |
|---|---|---|
| `index` | a 16 KiB header and 4,096 to 4,194,304 slots of 128 bytes (512 KiB to 512 MiB) | the daemon; clients map it read-only |
| `clients` | 512 MiB plus 128 KiB, sparse: only written log pages take disk | the daemon (header and dying table) and each client (its own slot) |
| `publisher.lock` | empty | the daemon holds a flock on it while it publishes |

### Versioning

The layout version is in the directory name (`v1-`), in each file's magic (`PODGCIDX`, `PODGCCLI`) and in a header field. A new layout gets a new version and a new directory, and files are never reinterpreted: an older client and a newer daemon (or the reverse) don't see each other's files, so the client works as S1 did and the daemon protects it by the S2 rules alone. A file whose version, geometry, cache identity, owner, mode or type doesn't match is refused. The daemon replaces a refused `clients` file by renaming a new one over it and never reinitializes one in place, because live clients may still hold slots in it.

### The index

The header holds the version, the geometry, the cache directory's device and inode, a random hash seed, a generation, the daemon's pid and boot UUID, and a `superseded` flag. Slots are found by linear probing, at most 64 steps, from a seeded hash of the whole action ID. Each slot holds the action ID, output ID, size and time from the `-a` line, and the inode and ctime the `-a` file had when the daemon read it. The daemon reads an `-a` file between two lstats and publishes it only when inode, ctime and size agree before and after.

Each slot is a seqlock: the daemon makes its sequence odd, writes the slot, then makes it even. A client retries a slot 4 times when the sequence is odd or moved, then reads the `-a` file instead, so nothing ever waits on the daemon. Past 45% live slots (65% counting deleted ones) the daemon writes a larger table to a new file, renames it over `index` and sets `superseded` in the old one; a client still mapping the old file moves to the new one on its next lookup.

### What a get does

1. Look the action ID up in the index.
2. If found, stat the `-a` file. The entry is used only when the inode and ctime equal the published ones and the size is 175 bytes. APFS changes the ctime on every write and every `utimes` (200,000 writes in a row never repeated one here), so a match means the file still holds the published line.
3. If not found, unsure (a slot being rewritten) or not matching, read the `-a` file as S1 does. A mismatch also flags the entry, so the daemon reads it again.
4. Refresh the `-a` and `-d` mtimes as Go's `markUsed` does, in the client, before answering, as S1 did.
5. Pin the output (below) and check the dying table. An output the daemon is deleting at this moment is answered as a miss.
6. Stat the `-d` file and answer.

A hit returns what reading the `-a` file at that moment would return, and an entry missing from the index is never a cache miss.

### Pins

A client claims one of the 256 slots in `clients` with an fcntl byte-range lock on that slot's byte. The lock belongs to the process, and the kernel drops it when the process exits, however it exits. A claim writes a new random token, the client's pid, its go process's pid and the boot UUID, so a reused slot or pid never inherits an older client's pins.

Each output the client hands to go, and each put, goes into the slot's log as a 32-byte record: the first 8 bytes of the output and action IDs, a kind and the size. Hits are logged once per output and session (again when a hit refreshed the mtimes or found the entry stale), puts always. The log holds 65,536 records; a session that fills it is counted in `extra.live.overflowedClients`, and the outputs it serves after that are not pinned. While such a session lives, outside the emergency tier, the daemon removes no output whose recency falls inside that session (from its claim, at most 6 hours back): `extra.live.overflowHoldSince` gives the start, `overflowKept` counts the removals held, and `extra.reasons` says so. An output it serves without refreshing (used under an hour before) keeps only S2's protection.

The daemon reads the new records of every slot each tick, at the start of every deletion batch and right before every output unlink. It does not delete an output pinned by a slot whose lock is still held, within three limits:

- A pin lasts at most 6 hours of awake time from the moment the daemon first saw it. The daemon's clock decides; nothing a client writes extends a pin.
- Pins keep at most 10 GB in total, the oldest live session's first (a long build reads its early outputs last). The rest show in `pinnedOverCapBytes` and are treated as unpinned.
- Below 7 GB free (the emergency tier), pinned outputs give way, but only after every unpinned candidate the tier's 15 minute window allows. A give-way lasts only while the emergency does: an output queued to give way whose removal comes after free disk is back above the emergency tier keeps its pin.

Nothing a client writes changes what another client is served: a record can only add a pin or ask the daemon to read an `-a` file again from disk.

### The deletion handshake

An output can be served while the daemon decides to delete it. Before unlinking outputs, the daemon writes up to 1,024 of them into the dying table of `clients`, activates that batch with one store, and then reads every log. A client appends its pin first and reads the dying table second. These fields are 64-bit atomics, sequentially consistent on arm64, so in every interleaving either the daemon's read sees the pin and keeps the output, or the client sees the batch and answers a miss.

A batch is honored for 60 seconds of awake time, and only by clients of the boot its daemon ran in: the awake clock restarts at boot, so a batch a dead daemon left from an earlier boot is ignored (a daemon that wrote no boot is trusted on age alone). The daemon unlinks nothing in a batch older than 30 seconds and starts a new batch instead, so a daemon that is stopped, starved or killed mid-batch turns outputs into misses for at most a minute. A starting daemon clears any batch its predecessor left active.

A put that finds its output in the active batch writes a fresh copy. It hard-links the new file into place once the old one is gone, and otherwise renames it over the old one after waiting at most 50 ms per session for the batch to end. The rename can land between the daemon's check and its removal, so the daemon never unlinks by name: it renames whatever the name holds to a private name in its bucket (a `.pgc-tmp.<pid>.<seq>` name, swept if the daemon dies there), checks that file's inode and recency, and unlinks it only if it is the file it checked. Anything else goes back under its name with `link(2)`, which never replaces a newer copy (copies of one output are the same bytes). `renamex_np(RENAME_EXCL)` would do the same, but needs libc, which the standard library does not expose without cgo.

### When the shared state is not used

Every failure leaves the client where S1 was: the `-a` file is read, mtimes are refreshed, and the output is protected by the S2 rules. Each session's op 10 trace record says why, once for the index and once for the pins:

| Reason | When |
|---|---|
| `missing` | No live directory or file: no daemon publishes for this cache. |
| `invalid` | Wrong magic, version, geometry, cache, owner, mode or file type (a FIFO, a symlink, a directory). |
| `denied` | EACCES or EPERM, as under a sandbox profile that denies the live directory. |
| `no-slot` | All 256 slots are held by live processes. |
| `fault` | A mapped file was truncated under the client. The fault is recovered (`debug.SetPanicOnFault`) and that part stays off for the rest of the session. |
| `off` | `POD_GOCACHE_LIVE=off` or the kill switch. |

The index and the pins fail independently. A client that can read the index but holds no slot (all taken, or writes denied) still serves from the index; what it serves has S1's protection. The kill switch turns off both and the trace.

The daemon falls back the same way. When it can't create or write the files (a full disk makes a write into a sparse page fault, which is recovered), it logs `shared state off`, the S2 rules alone decide, and it retries every minute. Only the cache's owner (the daemon holding the flock on the cache directory) takes `publisher.lock` and publishes; an observe daemon shares nothing, so it can never keep the owner from deleting. A daemon that finds `publisher.lock` held by another neither publishes nor deletes. A daemon that stops unmaps the files and releases the lock, so the next one publishes at once.

Every tick the daemon compares `index`, `clients` and `publisher.lock` (device, inode and size, by lstat) with the files it has mapped. A file deleted, replaced or cut short, or the whole directory removed, is logged (`shared state: ... recreating it`), recorded in `extra.live.lastRepair`, and recreated within that tick; readers of a replaced index are told to move to the new one. The old `clients` file stays mapped: the daemon keeps reading the logs of clients that claimed a slot in it, honors their pins and writes its dying batches into both files, until none of them lives (and at least a minute has passed). An old file that faults when read (cut short) is dropped, and its sessions' pins with it.

On start the daemon removes `.index.*` and `.clients.*` temp files of dead pids from its live directory, and sibling `v1-*` directories whose cache directory no longer exists (looked up by device and inode through `/.vol`; an unmounted volume keeps its directories), whose `publisher.lock` is free and whose `clients` file has no locked slot.

### Decisions (S9)

- Memory-mapped files, not a socket to the daemon. A get makes no extra system call, and a hung daemon can't stall go: the worst a stopped daemon causes is a stale index, where lookups fall back to the `-a` file, and for at most a minute a batch of up to 1,024 outputs answered as misses.
- Entries are checked against the inode and ctime of the `-a` file, not against a version the daemon keeps. The check costs the one stat that replaces the open, read and close, and it covers every writer: go's built-in cache, `go clean`, a person.
- Pins live in per-client logs, with fcntl locks for liveness. Every field has one writer, no counter is shared between cores, and a crashed client's pins end with its process. A pid alone can be reused, and a heartbeat can't tell a sleeping client from a dead one.
- Pin lifetime (6 hours awake), the 10 GB cap and the emergency give-way bound what pins can cost. In the simulated replay of S2's 35-session scenario under a 10 GB cap, free disk never went below 11 GB.
- A batch lives 60 seconds. The daemon has 30 of them for at most 1,024 unlinks, and a dead daemon's batch stops costing recompiles within a minute.
- The client's QoS class is unchanged: raising it showed no gain at load 14 to 19.
- Gate fixes (18.10): shared files deleted or replaced under the daemon are recreated within a tick, with the old `clients` file drained until its last client exits (`rm -rf` of the live directory left every client on `missing` with no pins). The emergency give-way lapses with the emergency. A dying batch is honored only within its daemon's boot. Removals take the file away under a private name and check it, so a put renaming over a dying output keeps its copy. An overflowed session holds removals of what it used outside the emergency tier. Only the owner publishes. The pin cap keeps the oldest session's pins. Clients report their counters and index reason in their slot; `state.json` sums them.

## Tests

```sh
go test -race -timeout 30m ./...                        # unit, protocol, daemon and simulation tests
POD_GOCACHE_REALGO=1 go test ./internal/realgo -v      # real go commands, about 3 minutes
POD_GOCACHE_E2E=1 go test ./internal/daemon -run E2E -v  # the daemon with real go, about 8 minutes
POD_GOCACHE_DST_SEEDS=96 go test ./internal/daemon -run TestDSTRandom  # more simulated days
POD_GOCACHE_LOADRIG=1 go test ./internal/daemon -run TestLoadRig -v       # indexing under busy threads on every core
```

The daemon's tests:

- `internal/cachesim` is a deterministic simulated machine: a GOCACHE, go processes that follow cmd/go's cache rules (the hourly mtime refresh, put order, shared outputs, executables, `go list -export` with readers after it), a process table, a disk, and wall and awake clocks that part on sleep. Every daemon file system call costs simulated time, so go runs between them. The world checks every removal against the rules independently of the daemon's code.
- `TestDSTRandom` runs random days on it (free disk through every tier, sleeps, clock steps, mode flips, crashes, local snapshots during which removals free nothing, future-dated and stray files) and then requires zero rule violations, no build failure outside the relaxed tiers, and convergence to the budget when idle. One of the rules is the low-disk allowance, replayed independently: in each episode, eviction below the budget stays within the largest deficit free disk would have had without the daemon's own removals, plus one unit. A unit is judged when its `-a` goes: chosen with the cache over the budget it keeps to the budget, otherwise it counts for disk in that episode, its output included even when the output goes later. The `TestS*` and `TestD4*` tests replay the skeptic scenarios one by one; `TestS12bHeartbeatUnderThrottledDisk` runs it on a disk where every call takes 50 ms. `TestRebootSkipsStartGrace` and `TestLoopLeavesBackgroundBandWhenBehind` cover the two Phase A follow-ups (no grace after a reboot; the loop out of the background band while behind). `TestHandoverSkipsStartGrace` (a clean stop and a start within 2 minutes evicts at once; a SIGKILL, a 3 minute gap, a clock set back, an observe run or another cache before keep the grace; a run stopped 30 minutes into its grace hands over the remaining 90 minutes, then removals start), `TestHandoverCarriesWindow` (a 5 h W set by a go process that exited just before the stop keeps an entry idle 3 h for 45 minutes, then lets it go), `TestFindHandoverRule` (the rule's edges, the carried grace included) and `TestHandoverAcrossProcesses` (the real binary after SIGTERM, whose grace ends with the stopped run's, and after SIGKILL, which starts a fresh one) cover handovers; the simulated machine applies the same rule on its own, so a removal inside a carried W or a carried grace fails every simulation, and both DST drivers mix kills with clean stops followed by gaps from none to 10 minutes.
- Real-filesystem tests (`TestS9`, `TestS16`, `TestS4b`, `TestTrimTxt`, `TestHeartbeatStopsWhenLoopWedges`) and process tests (duplicate daemons, two owners on one cache, the crash-loop breaker, 80 SIGKILLs, log rotation) use temp directories. The daemon package sets HOME to a temp directory, so a default that slips through never reaches `~/.pod/gocache` or `~/Library/Caches/go-build`.
- `TestE2E*` run the real go command on a temp GOCACHE at scaled windows, with every unlink checked against the configured window by the test's own lstat just before it: a build that outlives the window (and fails without the process-aware window), ten build, vet, test and list loops at 6 GB free over a 220-package module, export data read after go list exits, `go run` and `go tool` executables with a daemon killed between unlink and rmdir, `trim.txt` honored by go 1.27.2 and go 1.24.13, and `go clean -cache` under a running daemon.

`internal/realgo` builds the client and runs real go commands on a fixture module (`internal/realgo/testdata/fixture`), each mode on its own fresh temp GOCACHE:

- `TestMatrix`: build, `build -o`, vet (with a finding), test (a passing and a failing package), `test -v`, `-race`, `-cover`, `-coverprofile`, `list -export`, `list -test -compiled`, run, `test -c`, then `go clean -testcache` and the tests again. Cold and warm, built-in against client: exit codes, normalized output and the bytes of every binary, profile and export file must be identical, and the client's store must pass a full consistency check.
- `TestCrossRead*`: what the built-in cache wrote is a hit for the client (no compile, vet or link reruns, tests `(cached)`), and the other way round.
- `TestConcurrentProcessesShareOneCache`: two client and one built-in `go build -a ./...` at once on one fresh GOCACHE, then a consistent store and a warm build with no compile in both modes.
- `TestClientHitsKeepEntriesAliveAgainstBuiltinTrim`: entries aged 6 days, used through the client from the shared index, survive the built-in daily trim.
- Failure paths: read-only buckets (same messages as the built-in), a nearly full disk image, `go` killed mid-build, the client killed mid-build.
- `TestMatrix`, `TestCrossRead*`, `TestConcurrentProcessesShareOneCache` and `TestClientHitsKeepEntriesAliveAgainstBuiltinTrim` run with a daemon publishing for the cache (in the test process, its own state and live directories, outside the background band so a loaded machine can't starve it) and require most hits to come from the shared index: at least 300 and 60% in the matrix, 50 and 80% (built-in to client) and 20 and 30% (client to built-in) in the cross reads, 20 and 90% in the warm builds of the other two.
- `TestKillSwitchAndFIFOs`, `TestOtherCacheAndSpellings`, `TestSandboxedClient`: the kill switch with FIFOs in place of the shared files (never opened, atime unchanged, no trace) and the FIFOs refused without blocking; a client for another cache never touches the published state, while a symlink or a trailing slash to the same cache uses it and keeps its spelling in every export path; go under `sandbox-exec` profiles that deny writes outside the cache, reads of the live directory, or network and POSIX shared memory, each with the session reason it must report.

Shared state (S9) tests:

- `internal/livestate`: no torn reads under a writer rewriting slots (about 6 million lookups in 0.4 s, 60 s with `POD_GOCACHE_LONG=1`), colliding IDs sharing a probe chain and a hash prefix, a slot left odd by a stopped writer, faults from truncation recovered (inside `copy()` too), every refused file (wrong magic, version, cache, slots, size, mode, a symlink, directory, FIFO, empty or 10 GB sparse file), the handshake in 3,000 random interleavings (200,000 with `POD_GOCACHE_LONG=1`), a slot that lives exactly as long as its process (a helper process killed with SIGKILL), a clients file adopted across daemon restarts, batches older than `BatchLife` or from another boot ignored (`TestBatchFromAnotherBootIgnored`), the live count written once per round, and the start-up sweep (`TestCleanTemps`, `TestSweepStale`: only a directory whose cache is gone, with a free publisher lock and no held slot, goes).
- `internal/store`: fast hits, an `-a` rewritten in place never served from the stale entry, every entry shape through the fast path, `markUsed` still done by the client, a dying output answered as a miss, a put beside a dying output, and `TestDyingHandshakeAtEveryPoint`: the real `Get` against the real clients file with the daemon's begin, unlink and end injected before the get, before the pin, after the pin and after the get, in every order (every get misses or its `-d` is still there); `BenchmarkGetPaths` times a get on the S1, fast and stale paths.
- `internal/index` `TestRefreshedActionIsRead`: an `-a` rewritten in place and seen by the removal path is read again, so the index never pairs a new stat with old content.
- `internal/daemon` `TestS9Interleaving*`, `TestS5StalledBatchUnlinksNothing`, `TestS7*`, `TestS9Pinned*`, `TestB1*`, `TestS10*`, `TestS11*`, `TestS16*`, `TestS17*`, `TestEndedClientsHintsCount`, `TestGiveWayLapsesWithTheEmergency`, `TestOverflowedSessionKeepsWhatItUsed`, `TestPinCapKeepsTheOldestSession` and `TestDSTClients`: the skeptic's S9 scenarios on the simulated machine (and on real files: `TestRestartedDaemonPublishes`, a stopped daemon's successor publishes; `TestLiveDirDeletedMidRun`, the live directory deleted under a daemon process, index hits back for new sessions and a running client's pin from the deleted clients file still honored; `TestObserveDaemonNeverTakesThePublisherLock`; `TestStatusShowsClientSessions`), with go processes that run through a model of the client (index lookups, pins, the dying check, puts beside dying outputs). Each scenario that protects something has a sabotage run or a mutation that turns it red.
- `TestE2ES9*` (with `POD_GOCACHE_E2E=1`): S2's ten build, vet, test and list loops at 6 GB free with every go command through the client on the fast path; shared files truncated, replaced and renamed over, the daemon restarted and the live directory deleted under eight build and test loops, after which most sessions use the index again; the daemon stopped with SIGSTOP at random moments while go keeps working. Every e2e daemon publishes, so the built-in cache's runs (S1, S2, S10, S14, S15, S17) also run beside a publishing daemon.

The tests never use `~/Library/Caches/go-build`; the harness refuses to run against it. The test binaries of `internal/daemon`, `internal/realgo` and `cmd/pod-gocache` fail when the run changed anything in the real `~/.pod/gocache`, its `bin`, `~/Library/Caches/pod-gocache` or the real `trim.txt` (`internal/realhome`); the live daemon's own rewrites of `owner.json`, `state.json`, `daemon.log` and `trim.txt` pass when they name no temp path and the `trim.txt` time is the one `state.json` reports. Fuzz targets run with a throwaway cache too, because `go test -fuzz` keeps its corpus under GOCACHE:

```sh
GOCACHE=$(mktemp -d) go test ./internal/protocol -run '^$' -fuzz '^FuzzReader$' -fuzztime 3m
```

Fuzz targets: `FuzzParseFast` (whatever the hand-written request parser accepts, encoding/json reads identically), `FuzzReader` (arbitrary streams never panic or hang), `FuzzBodyRoundTrip` (any body, chunking and read size decodes exactly) and `FuzzParseEntryMatchesGo` (the `-a` parser against a verbatim copy of Go's). Their corpora live in `testdata/fuzz`.

## Cost per get

A get is what `go` asks for most (about 3,600 for a warm `go test` of `charter-service/internal/domain`, over 10,000 for `internal/handlers`). The client answers it with no allocation in its own code. Two small allocations remain inside the standard library, which copies each path into a C string for open(2) and stat(2). The file system calls match the built-in lookup: open, fstat, read and close of the `-a` file and one stat of the `-d` file. open(2) alone measured 12 to 20 µs on this Mac and dominates the lookup. The rest of the cost is the pipe round trip every GOCACHEPROG client pays, which grows with machine load (S0 `bench/RESULTS.md`, section 6).

With the shared state (S9), a hit served from the index makes one stat of the `-a` file instead of its open, fstat, read and close, then the stat of the `-d`: 4.0 to 6.7 µs per get in process against 18.4 to 23.4 µs for S1 (`BenchmarkGetPaths`, load 40). Through the pipe, below load 35 a get then costs what the built-in lookup costs inside go (23 to 25 µs at p50, against 43 to 48 µs for S1). With the CPU saturated the pipe round trip dominates again, and a warm `go test` of a cached package still waits on it: `bench/RESULTS.md`, section S9.
