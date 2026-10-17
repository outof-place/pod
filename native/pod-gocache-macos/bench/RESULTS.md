# pod-gocache S0: what each hot-path cost is on this Mac

Measured 2026-10-17 on Filip's M4 Pro while 30+ agent sessions were working, by the harness in this
directory. Every number below is a median over repeated, interleaved runs with its spread.

**Verdict:** a pure Go client meets bar (b) and bar (c) with room to spare: put tail 0.4 ms against
50 ms, and decode 3x to 30x faster than go sends. That holds only if it writes with pwrite: the
mmap tail is 47 to 62 ms. Bar (a) is met at moderate load (+0.11 s, 0.3%) and missed under the
heavy load that is normal here (+0.6 s, 1.0 to 1.4%). All of that overhead comes from about 4,400
get round trips per warm build. The decoder, mmap and the put path do not matter for (a).

## Bars

| bar | target | measured | verdict |
|---|---|---|---|
| (a) client overhead, warm `go build -o /dev/null ./cmd` | <= 1% vs built-in | before-link phase +0.60 s paired median (IQR -0.14..+1.08) on a 42.2 s build = **+1.4%** at load 43..450; get replay +0.61 s = **+1.0..1.4%** at load 60..115; get replay +0.11 s = **+0.3%** at load 44 | **missed under heavy load, met at moderate load** |
| (b) 254 MB put done after go's encode finishes | <= 50 ms | pwrite client: tail **0.4 to 0.5 ms** median (0.3..2.3 ms over 6 real puts of the 252 MB handlers archive, NEON and stdlib); dedupe skip 0.3 ms; mmap client: **49 ms** (47.4..61.8) | **pass with pwrite**, mmap at the limit (1 of 3 over) |
| (c) client decode GB/s >= go's encode GB/s | decode >= encode | go sends **0.34 GB/s** in a real put (encode + pipe), its encoder alone does **2.59 GB/s**; decode: NEON (archsimd) **7.85** whole / **10.35** in 64 KiB chunks, stdlib **2.98** / **2.50** | **pass**: NEON beats both definitions 3x to 30x; stdlib beats the real send rate 7x and ties the bare encoder |

GB/s here always counts decoded (binary) bytes, 1 GB = 1e9 bytes. Base64 text is 4/3 of that.

## Machine state during the runs

- Apple M4 Pro, 14 cores (10P+4E), 48 GB, macOS 27.0.1, Go 1.27.2 (Homebrew), `GOFLAGS=-p=2 -trimpath`.
- This shell runs under the Pod terminal daemon host (`Pod Runtime`), the same responsible app as the agent sessions,
  so first-exec scans hit us the same way they hit them.
- Load was heavy and moving the whole time: load1 43 to 450 (14 cores), swap used 8.9 to 14.8 GB (the swap
  file grew from 8 to 16 GB during the day), `memory_pressure` free 34 to 69%, kernel pressure level 1
  (normal) to 2 (warn). Each run records its own snapshot (`before` in the JSONL files).
- Portivo source: commit 71dd93fa28, exported with `git archive` to `/tmp/podgc-s0/src` (the repo is
  untouched; with `-trimpath` the directory does not enter action IDs).
- GOCACHE: an APFS clone of `~/Library/Caches/go-build` (37 GB, 75k files, 20 s to clone, no extra disk),
  warmed once for this commit. Nothing was ever written to the shared cache.

## Method

- **Interleaving.** Every measurement runs its cases round-robin, with the order rotated each round, so
  load drift hits every case alike. The e2e tables also report the **paired difference** within a round.
  Under this load it is the only honest wall-clock comparison.
- **Micro** (`cmd/micro`): a 254,000,000-byte random body, 7 rounds. Base64 throughput does not depend on
  content.
- **End to end** (`cmd/e2e`): real `go build` / `go test` of charter-service against the built-in cache and
  against `cmd/passprog`. That is a minimal GOCACHEPROG client: native GOCACHE layout, direct disk, no
  daemon, one request at a time. It timestamps every request in Unix ns.
  Each go command goes through the machine scheduler (`claude-acc run -- go ...`). `cmd/goshim` is first on
  PATH as `go`, so timing starts after admission and covers only the go process tree (wall, user+sys of go
  and every child it waited for).
  Put runs delete the handlers entry before each run, so every run recompiles and puts the full 252 MB.
  The trigger is a fresh `-gcflags=charter-service/internal/handlers=-c=4` action ID.
- **Phase split** (`-trace`): `go build -debug-trace` splits a warm build at the link action. Every get happens
  before the link (shown in the client logs: all gets land in the first 3 to 6 s). The link is 93% of the
  build and does not touch the cache.
- **Get replay** (`cmd/getrtt`): replays the exact get list of a real warm run, one at a time, against three paths:
  - passprog, over pipes framed byte for byte like `cmd/go/internal/cache/prog.go`;
  - an in-process copy of the built-in lookup (`DiskCache.get` plus `OutputFile`);
  - `passprog -echo`, which answers a miss without disk and gives the transport floor.
- **Decoder correctness** (`b64`, `go test`) is checked byte for byte against `encoding/base64`:
  - n, error offset and output bytes all compared;
  - lengths 0..300, every byte value at every position of a 128-char block;
  - 21 padding variants, CR/LF and quote insertions;
  - a dst sized exactly (guard bytes checked);
  - a 254 MB round trip, plus a fuzz target (45 s, 8.3 M inputs, no mismatch).
  Three deliberate mutations (roll table, validation table, store bound) each turn the suite red. The NEON
  speed is counted only after that.

## 1. base64 and SHA-256, in memory (micro, 7 rounds)

| case | GB/s median [min..max] | ms |
|---|---|---|
| go's encoder as cmd/go streams it (32 KiB reads, NewEncoder, 4 KiB bufio, no pipe) | **2.59** [0.87..2.83] | 98 |
| encode, whole buffer | 2.19 [1.05..2.31] | 116 |
| decode, whole buffer, stdlib | **2.98** [0.88..3.13] | 85 |
| decode, 64 KiB chunks (what one pipe read delivers), stdlib | **2.50** [0.75..3.21] | 102 |
| decode, whole buffer, NEON prototype (archsimd) | **7.85** [3.78..11.05] | 32 |
| decode, 64 KiB chunks, NEON prototype | **10.35** [3.40..11.02] | 25 |
| decode via `base64.NewDecoder` stream, stdlib | 0.86 [0.41..0.91] | 294 |
| SHA-256, 32 KiB reads (go's OutputID pass before every put) | 2.54 [0.89..2.81] | 100 |
| scan base64 for the closing quote (dedupe skip) | 46.7 [16.0..49.5] | 5 |
| memmove (bandwidth reference) | 38.4 [2.2..47.9] | 7 |

The NEON prototype (`b64/neon_arm64.go`) follows Muła and Lemire's nibble-table decoder:
- VTBL (`LookupOrZero`) does the classification and translation;
- `MulAdd` packs 16 sextets into 12 bytes;
- 4 vectors per 64-byte block, with one validity check per block;
- any block holding '=', CR/LF or an invalid byte goes to `encoding/base64` from that block on, so
  results stay identical.

Codegen findings that S1b needs (Go 1.27.2, arm64):
- `ShiftAllLeft/Right` with a constant compiles to a DUP plus USHL **at every use**, never an immediate
  shift. Hoist a shift vector and call `Shift(vector)` instead.
- A struct of vector constants passed by pointer is spilled to the stack and reloaded every use. Keep
  constants as plain locals; closures inline fine.
- Swapping shift/and/or for `MulAdd` in the pack step took the loop from about 6 to 8 to 10 GB/s. The
  32-bit step needs no mask, because the final VTBL never selects the garbage byte.
- archsimd on arm64 has 128-bit vectors only: no LD4/ST3 and no multi-register TBL, so the textbook
  NEON decoder (vld4/vst3) cannot be written.

## 2. Landing a 254 MB body on APFS (micro, 7 rounds)

"tail" is the time from the last chunk's arrival until the file is renamed into place.

| case | ms median | tail ms median [min..max] |
|---|---|---|
| pwrite each 48 KiB decoded chunk, NEON | 559 | **0.6** [0.2..0.9] |
| pwrite each 48 KiB decoded chunk, stdlib | 599 | 0.6 [0.2..1.8] |
| pwrite 1 MiB batches, NEON | 364 | 1.0 [0.6..3.3] |
| mmap, NEON decode straight into the mapping | 518 | **287** [129..2782] |
| mmap, stdlib decode straight into the mapping | 677 | 336 [69..4239] |
| decode into a fresh heap buffer, one write at the end | 232 | 164 [69..4303] |
| no decode: memcpy into an mmap | 369 | |
| no decode: pwrite 1 MiB blocks | 252 | |
| built-in put, new output (cmd/go DiskCache.put: SHA-256 pass + copy with SHA-256 tee) | **1364** | |
| built-in put, output already present (two SHA-256 passes, no write) | 367 | |

- Writing 254 MB of new file pages costs 250 to 600 ms under this memory pressure, whatever the method.
  The decoder (25 to 100 ms) is not the cost.
- mmap does not save total time. It moves the cost to `munmap` and `close` at the end, exactly where bar
  (b) is measured.
- For go, the built-in put is not cheaper than a GOCACHEPROG put: about 1.4 s against about 0.1 s of
  SHA-256 plus the stream (section 4).

## 3. Pipe, parent to child (micro, 7 rounds, child spawn excluded)

| producer -> consumer | GB/s median [min..max] | read(2) calls |
|---|---|---|
| cmd/go-shaped (encode + 4 KiB writes) -> child scanning for the quote | **0.32** [0.20..0.58] | 26,893 |
| cmd/go-shaped -> child decoding with NEON | 0.34 [0.21..0.50] | 25,312 |
| cmd/go-shaped -> child decoding with stdlib | 0.32 [0.19..0.59] | 23,706 |
| pre-encoded, 4 KiB writes (cmd/go's write size) -> scan | 0.79 [0.32..1.04] | 9,771 |
| pre-encoded, 64 KiB writes -> scan | 1.22 [0.90..3.44] | 5,169 |
| pre-encoded, 1 MiB writes -> scan | 0.55 [0.22..1.40] | 5,169 |

The consumer's decoder makes no difference. Go's encoder plus its 4 KiB pipe writes set the pace, at
about a third of a GB/s. A pipe read never returns more than 64 KiB.

## 4. Go-side ceiling of a real put: the 252 MB handlers archive

From `./run.sh e2e put`, 3 rounds per mode, load 50 to 431. stream runs from the opening quote to the
closing quote, as seen by the client: go's base64 encode plus pipe writes. tail runs from the closing
quote to the response.

| client mode | stream ms median [min..max] | stream MB/s | tail ms median [min..max] | body reads |
|---|---|---|---|---|
| dedupe (output exists, body skipped at scan speed) = go's own ceiling | **737** [255..866] | 342 | **0.3** [0.2..0.4] | 31,320 |
| decode NEON, pwrite per chunk | 1226 [952..1575] | 206 | **0.5** [0.4..2.3] | 15,629 |
| decode stdlib, pwrite per chunk | 753 [490..1247] | 335 | **0.4** [0.3..0.5] | 11,778 |
| decode NEON into mmap | 1187 [660..2004] | 212 | **49.0** [47.4..61.8] | 24,966 |

- Go itself spends about 0.1 s on the SHA-256 pass (section 1) plus 0.26 to 0.87 s streaming 252 MB.
  The client cannot speed that up; it can only fall behind.
- With an inline `pwrite` per chunk, the client falls behind sometimes (NEON-pwrite stream 1.2 s against
  0.74 s for dedupe). The pipe fills while the client sits in a pwrite of new pages, and go blocks.
  Decoupling disk writes from pipe reads (a reader that decodes into a ring, a writer that pwrites)
  should keep the stream at go's ceiling. S1b should measure that, not the decoder.
- Two runs show a 540 to 550 ms gap between the request line and the body. In mmap mode that is
  open+ftruncate+mmap; in stdlib-pwrite mode it is open of the temp file. These are APFS metadata
  stalls under pressure, rare but real, and they land before the stream starts.
- Wall time of these builds (builtin 78 s, client modes 30 to 57 s) is dominated by a 30 to 50 s compile
  of handlers at load up to 431. With n=3 it says nothing about the put. Do not read it as "the client is
  faster".

## 5. End to end, warm commands

Warm `go build -o /dev/null ./cmd`, built-in vs client. Two sessions:

| session | builtin wall s | client wall s | paired diff s | go-tree CPU s builtin / client |
|---|---|---|---|---|
| 1: 5 rounds, load 44..97 | 58.85 [39.82..97.18] | 74.37 [47.21..96.81] | +7.39 [-11.58..+26.00] | 29.06 / 29.27 |
| 2: 6 rounds with -debug-trace, load 43..450 | 42.21 [35.18..61.50] | 44.31 [34.45..54.00] | +0.99 [-11.77..+7.84], IQR -5.54..+5.37 | 27.19 / 27.37 |

Phases of session 2:

| mode | before link s | link s | after link s |
|---|---|---|---|
| builtin | 3.76 [2.87..5.51] | 38.99 [31.17..55.92] | 0.03 |
| client | 4.24 [3.00..5.76] | 39.43 [31.41..48.14] | 0.05 |
| paired diff, before link | **+0.60** [-1.04..+2.57], IQR -0.14..+1.08 | | |

Client view of session 2:
- 4,432 gets (4,402 hits), 1 put of 0 bytes;
- get p50 178 µs, p99 1,327 µs inside the client;
- sum of gets 1.11 s, client CPU 429 ms;
- startup 0.5 ms from main() to the capabilities line.

Run-to-run wall noise is 25 to 40% here, 25 to 40 times the bar, so the bar is judged on the phase split
and the replay below.

Warm `go test -run '^$' ./internal/handlers` (result cached), 10 rounds at load 46..59:

| mode | wall s | paired diff vs builtin | gets | get p50 / p99 µs in client | client CPU ms |
|---|---|---|---|---|---|
| builtin | 2.01 [1.53..3.94] | | | | |
| client (sequential) | 2.68 [1.52..4.03] | +0.48 s, +22.8% (IQR -0.12..+1.13 s) | 10,492 | 45.5 / 265 | 685 |
| client, 8 get workers | 3.12 [1.62..4.25] | +1.00 s, +45.6% | 10,492 | 85.5 / 1,305 | 998 |

A repeat with 8 rounds at load 59..105 gave builtin 1.49 s and client 2.01 s, paired +0.45 s (+30.8%).

- One warm `go test` of a cached package makes 10,492 gets: 7,438 under 1 KB, 2,354 up to 1 MB, 502 above
  1 MB. A cached result costs the client about a third of a second to a half second per command, every time.
- Answering gets from 8 goroutines is worse than answering them in order: handoffs and lock contention
  double the latency.
- The module index is not where the gets come from. `GODEBUG=goindex=0` removes only 971 gets, and it
  costs go 8 s more CPU parsing sources: builtin-noindex 2.43 s, client-noindex 2.57 s against builtin
  1.49 s. Not a lever.

## 6. Get round trip, replayed one at a time

Same get lists as above, 5 replays after a warm-up.

| list, load | path | p50 µs | mean µs | sum per replay ms |
|---|---|---|---|---|
| warm build, 4,432 gets, load 44 | passprog over pipes | 47.0 | 49.0 | 219 [212..223] |
| | built-in lookup in process | 24.1 | 25.2 | 109 [107..123] |
| | transport floor (`-echo`, no disk) | 11.7 | 14.1 | 57 [54..78] |
| warm test, 10,492 gets, load 44 | passprog over pipes | 47.9 | 52.1 | 533 [495..650] |
| | built-in lookup in process | 24.0 | 24.8 | 258 [250..271] |
| | transport floor | 11.5 | 13.3 | 132 [126..177] |
| warm build, 4,432 gets, load 60..115 (earlier) | passprog over pipes | 116.5 | 205.4 | 860 [700..1118] |
| | built-in lookup in process | 32.5 | 53.8 | 251 [191..261] |

- At moderate load a get costs the client 24 µs more than the built-in lookup, in two parts:
  - about 12 to 14 µs of transport (JSON both sides, 4 pipe syscalls, 2 wakeups);
  - about 11 µs of client work beyond the lookup itself: the larger hit response with a time stamp,
    hex formatting for the event log, allocations. The file syscalls match the built-in (open, read and
    close of -a, one stat of -d), and the echo floor already includes JSON on both sides.
- Under heavy load the transport balloons, because every round trip needs the client and go to be
  scheduled again: +152 µs mean per get.
- Bar (a) budget: 1% of a 42 s warm build is 420 ms, or 95 µs added per get over 4,432 gets.
  - The minimal client is inside that at load 44 (+25 µs) and outside it at load 60..115 (+152 µs).
  - A warm `go test` of a cached package can never meet a 1% bar over pipes: 1% of 1.5 s across
    10,492 gets is 1.4 µs, below the 12 µs transport floor.

## 7. Exec cost of the client per go command (`./run.sh exec`)

| exec | n | ms to capabilities line, median [min..max] | p90 |
|---|---|---|---|
| first exec of a freshly linked 3.9 MB client (new code hash) | 6 | **268** [219..801] | 555 |
| later execs of the same binary | 180 | **6.4** [3.2..24.2] | 12.3 |
| `/usr/bin/true`, reference | 30 | 3.5 [2.5..35.8] | 8.8 |

- The first exec after every new build of the client pays the macOS scan once, 0.2 to 0.8 s.
- After that the client costs about 3 ms more than `true`. Startup inside main() is 0.1 to 2.6 ms.

## What this means for the next stages

1. **The per-get round trip is the whole overhead on warm builds.** S1 should optimize it, not the put path:
   - no encoding/json and no per-request formatting on the get path; write a preformatted response;
   - decide whether the -d stat is needed (with GOCACHEPROG set, go does not stat -d again; the built-in
     does it in OutputFile), or make it cheaper with fstatat on an open bucket directory;
   - one write per response;
   - keep the read loop in order, since workers made it worse.
   About 25 µs of the 49 µs is fixable; the 12 to 14 µs transport is the floor at moderate load.
2. **Warm `go test` of a cached package pays about +0.3 to +0.5 s per command with any GOCACHEPROG client**,
   because go makes over 10k gets. That is a product-level cost of GOCACHEPROG itself. It should be weighed
   against what the cache saves before Pod injects GOCACHEPROG into every terminal.
3. **Put path: pwrite per chunk, never mmap.** The tail stays under 1 ms. The plan's "mmap the temp file"
   costs 47 to 62 ms of tail e2e and 129 to 2,782 ms in micro, and saves nothing. Next, decouple disk
   writes from pipe reads so go's stream is never throttled by the client.
4. **The decoder is not on the critical path.** Go sends at about 0.34 GB/s. stdlib decode at 2.5 to
   3.0 GB/s already has 7x headroom, and the NEON prototype at 7.9 to 10.4 GB/s has 23x or more. Ship NEON
   for CPU savings, or ship stdlib and drop the experiment pin. Either way bar (c) holds.
5. **Dedupe works.** Skipping an existing output costs 0.3 ms of tail and leaves the stream at go's own
   ceiling.
6. **Exec:** keep the client binary stable across Pod releases where possible. Each new build costs one
   0.2 to 0.8 s scan on first use.

## Not measured, and why

- **Bar (a) by wall clock alone.** Load moved from 43 to 450 during single sessions, and runs differ by 25
  to 40%. A 1% effect cannot be resolved that way on this machine today. The phase split and the replay
  are the substitutes; both are above.
- **The SHA-256 pass inside a real go put.** It happens before the request line, so the client cannot see
  it. Section 1 measures it (about 0.1 s for 252 MB at 2.54 GB/s).
- **The built-in put inside a real build.** The same holds; section 2 has an exact replica of
  `DiskCache.put`.

## Re-running

From this directory. Throwaway state lives in `$WORK` (default `/tmp/podgc-s0`); results are written to
`$WORK/results`, and per-run JSONL to `$WORK/e2e`.

| measurement | command |
|---|---|
| snapshot, cache clone, binaries, warm-up | `./run.sh setup` |
| decoder correctness (simd and scalar builds) | `./run.sh test` |
| micro: base64, SHA-256, APFS writes, pipe | `./run.sh micro all` (or `b64`, `write`, `pipe`; `REPS=7`) |
| exec cost | `./run.sh exec` (`FRESH=6 LATER=30`) |
| warm build with phase split | `TRACE=1 ./run.sh e2e warm-build builtin,client 6` |
| warm test | `./run.sh e2e warm-test builtin,client,client-par 10` |
| module index on/off | `./run.sh e2e warm-test builtin,client,builtin-noindex,client-noindex 8` |
| real 252 MB puts | `WARMUP=0 ./run.sh e2e put builtin,dedupe,neon-pwrite,neon-mmap,stdlib-pwrite 3` |
| get replay | `./run.sh getrtt <a passprog .prog.jsonl from a warm run>` |
| remove everything | `./run.sh clean` |
