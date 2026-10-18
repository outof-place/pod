package realgo

import (
	"os"
	"sync"
	"testing"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

// TestConcurrentProcessesShareOneCache: many go processes, clients and a
// built-in one, rebuild everything (-a puts every output again) against one
// fresh GOCACHE at the same time, as parallel terminals do. None may fail, the
// store must stay consistent, and both modes must then find everything cached.
func TestConcurrentProcessesShareOneCache(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	pub := startPublisher(t, ce)

	modes := []bool{true, true, false}
	results := make([]result, len(modes))
	var wg sync.WaitGroup
	for i, prog := range modes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = runGo(t, ws, ce.withProg(prog), "build", "-a", "./...")
		}()
	}
	wg.Wait()
	for i, prog := range modes {
		if r := results[i]; r.code != 0 || r.stderr != "" {
			t.Errorf("process %d (client=%v): exit %d\n%s", i, prog, r.code, tail(r.stderr, 10))
		}
	}

	entries, outputs := checkStore(t, ce.gocache)
	t.Logf("store: %d entries, %d outputs; client trace %v", entries, outputs, traceCounts(t, ce.trace))
	if entries == 0 {
		t.Fatal("nothing was stored")
	}
	counts := traceCounts(t, ce.trace)
	if counts[trace.OpStart] != 2 || counts[trace.OpClose] != 2 {
		t.Errorf("want two complete client sessions, got %v", counts)
	}
	// Another process finishing the same put can hide a failed one from the
	// warm build below, so failures are counted directly.
	if counts[trace.OpPutFailed] != 0 {
		t.Errorf("%d puts failed under concurrency: %v", counts[trace.OpPutFailed], counts)
	}

	pub.sync(t, ce)
	os.RemoveAll(ce.trace)
	for _, prog := range []bool{true, false} {
		r := runGo(t, ws, ce.withProg(prog), "build", "-x", "./...")
		if r.code != 0 || compileRE.MatchString(r.stderr) {
			t.Errorf("warm build (client=%v) recompiled (exit %d):\n%s", prog, r.code, joinMatches(r.stderr))
		}
	}
	requireFast(t, ce, 20, 0.9) // the client's warm build, from what the daemon published
	checkStore(t, ce.gocache)
}
