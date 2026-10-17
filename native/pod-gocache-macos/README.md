# pod-gocache

Pod's Go build cache. Today it is a GOCACHEPROG client: `go` starts it, asks it for cached outputs and hands it new ones, and it keeps them in the very same GOCACHE directory, in the same format, that the built-in cache uses. A go command with `GOCACHEPROG="<path> prog"` reads entries the built-in cache wrote and writes entries the built-in cache reads. Rolling back means unsetting GOCACHEPROG. A launchd daemon (pins, eviction, deduplicated compiles, metrics) comes in later stages; the client never needs it.

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
| `pod-gocache daemon` | Not implemented yet: prints `pod-gocache daemon: not implemented` to stderr and exits 69 (EX_UNAVAILABLE). |
| `pod-gocache status --json` | Prints one JSON line, `{"version":"<version>","mode":"standalone"}`, exit 0. `status` without `--json` prints the same in words (`pod-gocache <version>: standalone (no daemon)`); `-json` is accepted as an alias of `--json`. Later stages add fields; these two stay. |
| `pod-gocache version` | Prints the bare version on one line, exit 0. |

Anything else prints usage to stderr and exits 64 (EX_USAGE). New flags, if any, will be optional.

## Environment

| Variable or file | Effect |
|---|---|
| `GOCACHE` | The store. `go` sets it to its effective value (absolute) for every subprocess (`cmd/go/main.go`, `envcmd.MkEnv`), so the client never runs `go env`. Unset, the client uses go's default, `os.UserCacheDir()/go-build`. `off`, a relative path, invalid UTF-8 or a path near PATH_MAX leaves the client without a store: gets miss and puts fail. `go` itself refuses to start in those cases, so this only matters when the client is run by hand. |
| `POD_GOCACHE_TRACE_DIR` | Where the access trace goes. Default `~/.pod/gocache/trace`. |
| `POD_GOCACHE_TRACE=off` | No trace. |
| `~/.pod/gocache/disabled` | Kill switch, checked once at start. When the file exists the client writes no trace and will contact no daemon: it is a plain native-layout disk cache. This is the rollback for terminals whose environment already holds GOCACHEPROG. |

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
| 38 | 1 | op: 1 start, 2 get hit, 3 get miss, 4 put stored, 5 put of an existing output, 6 put failed, 7 close, 8 end of input without close |
| 39 | 1 | format version, 1 |

`internal/trace.ReadDir` decodes a trace directory.

## Tests

```sh
go test -race ./...                                    # unit and protocol tests
POD_GOCACHE_REALGO=1 go test ./internal/realgo -v      # real go commands, about 3 minutes
```

`internal/realgo` builds the client and runs real go commands on a fixture module (`internal/realgo/testdata/fixture`), each mode on its own fresh temp GOCACHE:

- `TestMatrix`: build, `build -o`, vet (with a finding), test (a passing and a failing package), `test -v`, `-race`, `-cover`, `-coverprofile`, `list -export`, `list -test -compiled`, run, `test -c`, then `go clean -testcache` and the tests again. Cold and warm, built-in against client: exit codes, normalized output and the bytes of every binary, profile and export file must be identical, and the client's store must pass a full consistency check.
- `TestCrossRead*`: what the built-in cache wrote is a hit for the client (no compile, vet or link reruns, tests `(cached)`), and the other way round.
- `TestConcurrentProcessesShareOneCache`: two client and one built-in `go build -a ./...` at once on one fresh GOCACHE, then a consistent store and a warm build with no compile in both modes.
- `TestClientHitsKeepEntriesAliveAgainstBuiltinTrim`: entries aged 6 days, used through the client, survive the built-in daily trim.
- Failure paths: read-only buckets (same messages as the built-in), a nearly full disk image, `go` killed mid-build, the client killed mid-build.

The tests never use `~/Library/Caches/go-build`; the harness refuses to run against it. Fuzz targets run with a throwaway cache too, because `go test -fuzz` keeps its corpus under GOCACHE:

```sh
GOCACHE=$(mktemp -d) go test ./internal/protocol -run '^$' -fuzz '^FuzzReader$' -fuzztime 3m
```

Fuzz targets: `FuzzParseFast` (whatever the hand-written request parser accepts, encoding/json reads identically), `FuzzReader` (arbitrary streams never panic or hang), `FuzzBodyRoundTrip` (any body, chunking and read size decodes exactly) and `FuzzParseEntryMatchesGo` (the `-a` parser against a verbatim copy of Go's). Their corpora live in `testdata/fuzz`.

## Cost per get

A get is what `go` asks for most (about 3,600 for a warm `go test` of `charter-service/internal/domain`, over 10,000 for `internal/handlers`). The client answers it with no allocation in its own code. Two small allocations remain inside the standard library, which copies each path into a C string for open(2) and stat(2). The file system calls match the built-in lookup: open, fstat, read and close of the `-a` file and one stat of the `-d` file. open(2) alone measured 12 to 20 µs on this Mac and dominates the lookup. The rest of the cost is the pipe round trip every GOCACHEPROG client pays, which grows with machine load (S0 `bench/RESULTS.md`, section 6).
