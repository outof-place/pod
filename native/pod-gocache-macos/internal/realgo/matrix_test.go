package realgo

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

// step is one go command of the matrix. artifacts names files whose content
// must also match between the caches.
type step struct {
	name      string
	args      []string
	artifacts func(t *testing.T, ws workspace, ce cacheEnv, r result) map[string]string
}

var matrix = []step{
	{name: "build", args: []string{"build", "./..."}},
	{name: "build-o", args: []string{"build", "-o", "$OUT/hello", "./cmd/hello"}, artifacts: outFiles("hello")},
	{name: "vet", args: []string{"vet", "./..."}},
	{name: "test", args: []string{"test", "./..."}},
	{name: "test-v-pass", args: []string{"test", "-v", "./greet"}},
	{name: "test-race", args: []string{"test", "-race", "./greet", "./calc"}},
	{name: "test-cover", args: []string{"test", "-cover", "./greet", "./calc"}},
	{name: "test-coverprofile", args: []string{"test", "-coverprofile=$OUT/cover.out", "./calc"}, artifacts: outFiles("cover.out")},
	{name: "list-export", args: []string{"list", "-export", "-f", "{{.ImportPath}} {{.Export}}", "./..."}, artifacts: exportFiles},
	{name: "list-test-compiled", args: []string{"list", "-test", "-compiled", "-f", "{{.ImportPath}}: {{.GoFiles}} {{.CompiledGoFiles}}", "./greet"}, artifacts: cachedGoFiles},
	{name: "run", args: []string{"run", "./cmd/hello", "a", "b"}},
	{name: "test-c", args: []string{"test", "-c", "-o", "$OUT/calc.test", "./calc"}, artifacts: outFiles("calc.test")},
}

// final runs once after the warm pass: go clean -testcache writes testexpire.txt,
// and test.go:1979 must then ignore every cached result older than it.
var final = []step{
	{name: "clean-testcache", args: []string{"clean", "-testcache"}},
	{name: "test-after-clean", args: []string{"test", "./greet", "./calc"}},
	{name: "test-cached-again", args: []string{"test", "./greet", "./calc"}},
}

// expectations every mode must meet on its own, so two equally broken caches
// cannot pass by agreeing.
var expectations = map[string]func(o outcome) bool{
	"warm/test-v-pass":        func(o outcome) bool { return strings.Contains(o.stdout, "(cached)") },
	"warm/test-race":          func(o outcome) bool { return strings.Count(o.stdout, "(cached)") == 2 },
	"warm/test-cover":         func(o outcome) bool { return strings.Count(o.stdout, "(cached)") == 2 },
	"final/test-after-clean":  func(o outcome) bool { return o.code == 0 && !strings.Contains(o.stdout, "(cached)") },
	"final/test-cached-again": func(o outcome) bool { return strings.Count(o.stdout, "(cached)") == 2 },
	"warm/build-o":            func(o outcome) bool { return !strings.HasPrefix(o.artifacts["hello"], "missing") },
}

// exportFiles hashes every export file go list printed: the files must exist
// after go exits and match between caches.
func exportFiles(t *testing.T, ws workspace, ce cacheEnv, r result) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(r.stdout), "\n") {
		pkg, path, ok := strings.Cut(line, " ")
		if !ok || path == "" {
			continue
		}
		m[pkg] = fileSum(t, path)
	}
	return m
}

// cachedGoFiles hashes the generated test main go list points into the cache.
func cachedGoFiles(t *testing.T, ws workspace, ce cacheEnv, r result) map[string]string {
	m := map[string]string{}
	for _, f := range strings.Fields(strings.NewReplacer("[", " ", "]", " ").Replace(r.stdout)) {
		if strings.HasPrefix(f, ce.gocache) {
			m[normalize(f, ws, ce)] = fileSum(t, f)
		}
	}
	if len(m) == 0 {
		t.Errorf("go list -test printed no cached file:\n%s", r.stdout)
	}
	return m
}

func outFiles(names ...string) func(*testing.T, workspace, cacheEnv, result) map[string]string {
	return func(t *testing.T, ws workspace, _ cacheEnv, _ result) map[string]string {
		m := map[string]string{}
		for _, n := range names {
			m[n] = fileSum(t, ws.out+"/"+n)
		}
		return m
	}
}

type outcome struct {
	code      int
	stdout    string
	stderr    string
	artifacts map[string]string
}

func (o outcome) String() string {
	return fmt.Sprintf("exit %d\n--- stdout\n%s\n--- stderr\n%s\n--- artifacts %v", o.code, tail(o.stdout, 12), tail(o.stderr, 12), o.artifacts)
}

// phases run in order on one cache: cold fills it, warm reads it back.
var phases = []struct {
	name  string
	steps []step
}{{"cold", matrix}, {"warm", matrix}, {"final", final}}

func runMatrix(t *testing.T, ws workspace, ce cacheEnv, pub *publisher) map[string]outcome {
	t.Helper()
	got := map[string]outcome{}
	for _, ph := range phases {
		if pub != nil {
			pub.sync(t, ce) // the phase starts with every entry published
		}
		for _, s := range ph.steps {
			key := ph.name + "/" + s.name
			resetDir(t, ws.out)
			r := runGo(t, ws, ce, append([]string(nil), s.args...)...)
			o := outcome{code: r.code, stdout: normalize(r.stdout, ws, ce), stderr: normalize(r.stderr, ws, ce)}
			if s.artifacts != nil {
				o.artifacts = s.artifacts(t, ws, ce, r)
			}
			got[key] = o
		}
	}
	return got
}

// TestMatrix runs every step cold, warm and after go clean -testcache with the
// built-in cache and with the client, each on its own fresh GOCACHE, and
// requires identical results. A daemon publishes shared state for the
// client's cache (B4), and most client hits must come from it (G1).
func TestMatrix(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	builtin := runMatrix(t, ws, newCache(t, false), nil)
	cc := newCache(t, true)
	// S14 skew: POD_GOCACHE_DAEMON_BIN runs another daemon build (S2's) beside
	// the client instead of this one; POD_GOCACHE_CLIENT_BIN, another client.
	var pub *publisher
	if bin := os.Getenv("POD_GOCACHE_DAEMON_BIN"); bin != "" {
		startDaemonBin(t, bin, cc)
	} else {
		pub = startPublisher(t, cc)
	}
	client := runMatrix(t, ws, cc, pub)
	if skewed() {
		_, l, reasons := liveSessions(t, cc.trace)
		t.Logf("skew run: sessions by index reason %v, fast hits %d", reasons, l.Fast)
	} else {
		requireFast(t, cc, 300, 0.6)
	}
	be, bo := checkStore(t, cc.gocache)
	t.Logf("client store: %d index entries, %d outputs, all consistent", be, bo)
	counts := traceCounts(t, cc.trace)
	t.Logf("client trace: %v", counts)
	if counts[trace.OpPutStored] == 0 || counts[trace.OpGetHit]+counts[trace.OpGetFast] == 0 || counts[trace.OpClose] == 0 {
		t.Errorf("the client was not exercised: %v", counts)
	}
	if counts[trace.OpPutFailed] != 0 {
		t.Errorf("puts failed: %v", counts)
	}
	for _, ph := range phases {
		for _, s := range ph.steps {
			key := ph.name + "/" + s.name
			b, c := builtin[key], client[key]
			if ok := expectations[key]; ok != nil && (!ok(b) || !ok(c)) {
				t.Errorf("%s misses its expectation\n=== builtin\n%s\n=== client\n%s", key, b, c)
			}
			if b.code != c.code || b.stdout != c.stdout || b.stderr != c.stderr || fmt.Sprint(b.artifacts) != fmt.Sprint(c.artifacts) {
				t.Errorf("%s differs\n=== builtin\n%s\n=== client\n%s", key, b, c)
				continue
			}
			t.Logf("%s: identical (exit %d) %s", key, b.code, strings.ReplaceAll(tail(b.stdout+b.stderr, 3), "\n", " | "))
		}
	}
}

func traceCounts(t *testing.T, dir string) map[trace.Op]int {
	t.Helper()
	recs, err := trace.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading trace: %v", err)
	}
	m := map[trace.Op]int{}
	for _, r := range recs {
		m[r.Op]++
	}
	return m
}
