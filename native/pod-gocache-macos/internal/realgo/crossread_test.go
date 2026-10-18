package realgo

import (
	"regexp"
	"strings"
	"testing"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

var (
	compileRE = regexp.MustCompile(`(?m)pkg/tool/[^/ ]+/compile `)
	linkRE    = regexp.MustCompile(`(?m)pkg/tool/[^/ ]+/link `)
	vetRE     = regexp.MustCompile(`(?m)pkg/tool/[^/ ]+/vet `)
)

func joinMatches(stderr string) string {
	return strings.Join(compileRE.FindAllString(stderr, 5), "\n")
}

// populate fills a cache with every kind of entry the fixture produces:
// archives, test results, vet facts and (built-in only) a go run executable.
// It also proves the -x patterns match real tool runs.
func populate(t *testing.T, ws workspace, ce cacheEnv) {
	t.Helper()
	r := runGo(t, ws, ce, "build", "-x", "./...")
	if r.code != 0 || !compileRE.MatchString(r.stderr) {
		t.Fatalf("%s cold build: exit %d, compiles seen %v\n%s", ce.mode(), r.code, compileRE.MatchString(r.stderr), tail(r.stderr, 10))
	}
	if r := runGo(t, ws, ce, "test", "./greet", "./calc"); r.code != 0 {
		t.Fatalf("%s cold test: %s", ce.mode(), r.stdout+r.stderr)
	}
	if r := runGo(t, ws, ce, "vet", "-x", "./greet", "./calc"); r.code != 0 || !vetRE.MatchString(r.stderr) {
		t.Fatalf("%s cold vet: exit %d, vet runs seen %v", ce.mode(), r.code, vetRE.MatchString(r.stderr))
	}
	if r := runGo(t, ws, ce, "run", "-x", "./cmd/hello"); r.code != 0 || !linkRE.MatchString(r.stderr) {
		t.Fatalf("%s cold run: exit %d, links seen %v", ce.mode(), r.code, linkRE.MatchString(r.stderr))
	}
}

// requireWarm checks that the other side reuses everything populate stored.
func requireWarm(t *testing.T, ws workspace, ce cacheEnv, wantCachedExe bool) {
	t.Helper()
	if r := runGo(t, ws, ce, "build", "-x", "./..."); r.code != 0 || compileRE.MatchString(r.stderr) {
		t.Errorf("%s warm build recompiled (exit %d):\n%s", ce.mode(), r.code, strings.Join(compileRE.FindAllString(r.stderr, 5), "\n"))
	}
	r := runGo(t, ws, ce, "test", "./greet", "./calc")
	if r.code != 0 || strings.Count(r.stdout, "(cached)") != 2 {
		t.Errorf("%s warm test not cached (exit %d):\n%s", ce.mode(), r.code, r.stdout)
	}
	if r := runGo(t, ws, ce, "vet", "-x", "./greet", "./calc"); r.code != 0 || vetRE.MatchString(r.stderr) {
		t.Errorf("%s warm vet reran vet (exit %d)", ce.mode(), r.code)
	}
	r = runGo(t, ws, ce, "run", "-x", "./cmd/hello")
	if r.code != 0 || strings.TrimSpace(r.stdout) != "hello, pod 42 []" {
		t.Errorf("%s warm run: exit %d, stdout %q", ce.mode(), r.code, r.stdout)
	}
	if linked := linkRE.MatchString(r.stderr); linked == wantCachedExe {
		t.Errorf("%s warm run: linked=%v, want cached executable=%v", ce.mode(), linked, wantCachedExe)
	}
}

// TestCrossReadBuiltinToClient: entries the built-in cache wrote are hits for
// the client, including the built-in's go run executable directories, and
// with a daemon publishing them most hits come from the shared index.
func TestCrossReadBuiltinToClient(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, false)
	pub := startPublisher(t, ce)
	populate(t, ws, ce)
	pub.sync(t, ce)
	requireWarm(t, ws, ce.withProg(true), true)
	requireFast(t, ce, 50, 0.8)
	checkStore(t, ce.gocache)
	counts := traceCounts(t, ce.trace)
	t.Logf("client trace: %v", counts)
	if counts[trace.OpGetHit]+counts[trace.OpGetFast] == 0 || counts[trace.OpPutStored] != 0 {
		t.Errorf("client should only read the built-in's entries: %v", counts)
	}
}

// TestCrossReadClientToBuiltin: entries the client wrote are hits for the
// built-in cache. The client cannot cache executables (cmd/go only does that
// for *DiskCache), so the built-in links go run once.
func TestCrossReadClientToBuiltin(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	pub := startPublisher(t, ce)
	populate(t, ws, ce)
	pub.sync(t, ce)
	requireFast(t, ce, 20, 0.3)
	counts := traceCounts(t, ce.trace)
	if counts[trace.OpPutStored] == 0 {
		t.Fatalf("client stored nothing: %v", counts)
	}
	requireWarm(t, ws, ce.withProg(false), false)
	checkStore(t, ce.gocache)
}
