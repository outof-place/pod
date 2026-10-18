package realgo

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/daemon"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

// publisher is a daemon owning one test cache and publishing shared state
// for it (only the owner publishes), in this test process (go's clients are
// other processes), with its own state and live directories and tick
// lengths a test can wait for. Its budget and free disk are so large that it
// never removes anything. It stays out of the background band: at load 130 a
// background thread published nothing for a minute, and these tests wait
// for it.
type publisher struct {
	state string
	stop  func()
	done  chan int
}

func startPublisher(t *testing.T, ce cacheEnv) *publisher {
	t.Helper()
	p := &publisher{state: filepath.Join(filepath.Dir(ce.live), "state"), done: make(chan int, 1)}
	ownMode(t, p.state)
	ctx, cancel := context.WithCancel(context.Background())
	limits := evict.Defaults()
	limits.Budget = 1 << 50
	cfg := daemon.Config{
		CacheDir: ce.gocache, StateDir: p.state, LiveRoot: ce.live, Version: "realgo", Limits: limits, Disk: plentyOfDisk{},
		Tick: 20 * time.Millisecond, HeartbeatEvery: 50 * time.Millisecond, IdleRelist: 20 * time.Millisecond,
		PressureRelist: 20 * time.Millisecond, ScanBudget: 500 * time.Millisecond, RestatCycle: 2 * time.Second,
		PressureRestat: 2 * time.Second, PlanEvery: time.Second, ProcEvery: time.Second, Log: io.Discard,
		Prio: foreground{},
	}
	go func() { p.done <- daemon.Run(ctx, cfg) }()
	p.stop = func() {
		cancel()
		select {
		case <-p.done:
		case <-time.After(10 * time.Second):
			t.Error("publisher did not stop")
		}
	}
	t.Cleanup(p.stop)
	return p
}

type foreground struct{}

func (foreground) Background(bool) {}

// plentyOfDisk keeps the publisher out of every low-disk tier.
type plentyOfDisk struct{}

func (plentyOfDisk) Free() (int64, error) { return 1 << 50, nil }

// ownMode writes mode=owner into a state directory.
func ownMode(t *testing.T, state string) {
	t.Helper()
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, ownerstate.ModeFile), []byte("owner"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func skewed() bool {
	return os.Getenv("POD_GOCACHE_DAEMON_BIN") != "" || os.Getenv("POD_GOCACHE_CLIENT_BIN") != ""
}

// startDaemonBin runs another daemon build owning the cache (S9 builds
// publish only as owner), with its own state directory and a throwaway HOME.
func startDaemonBin(t *testing.T, bin string, ce cacheEnv) {
	t.Helper()
	root := filepath.Dir(ce.live)
	ownMode(t, filepath.Join(root, "other-state"))
	cmd := exec.Command(bin, "daemon", "--cache-dir", ce.gocache, "--state-dir", filepath.Join(root, "other-state"))
	cmd.Env = append(os.Environ(), "HOME="+filepath.Join(root, "other-home"))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		cmd.Wait()
	})
}

// sync waits until every -a file in the cache is published.
func (p *publisher) sync(t *testing.T, ce cacheEnv) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for {
		want := countActions(t, ce.gocache)
		st, ok, _ := ownerstate.ReadState(p.state)
		if ok && st.Extra.Live != nil && st.Extra.Live.Entries == want && st.Extra.Phase == "ready" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("publisher never caught up: %d -a files, state %+v", want, st.Extra.Live)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func countActions(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	buckets, _ := os.ReadDir(dir)
	for _, b := range buckets {
		if !b.IsDir() || len(b.Name()) != 2 {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(dir, b.Name()))
		for _, f := range files {
			if strings.HasSuffix(f.Name(), "-a") {
				n++
			}
		}
	}
	return n
}

// liveSessions sums the client sessions' OpLive records.
func liveSessions(t *testing.T, dir string) (sessions int, l trace.Live, reasons map[uint8]int) {
	t.Helper()
	recs, err := trace.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	reasons = map[uint8]int{}
	for _, r := range recs {
		if r.Op != trace.OpLive {
			continue
		}
		sessions++
		s := r.Live()
		l.Fast += s.Fast
		l.Disk += s.Disk
		l.Stale += s.Stale
		l.DyingMisses += s.DyingMisses
		l.DyingPuts += s.DyingPuts
		reasons[s.Index]++
	}
	return sessions, l, reasons
}

// requireFast is G1: the client really served from the shared state.
func requireFast(t *testing.T, ce cacheEnv, minFast int, minShare float64) {
	t.Helper()
	counts := traceCounts(t, ce.trace)
	fast, hits := counts[trace.OpGetFast], counts[trace.OpGetFast]+counts[trace.OpGetHit]
	_, l, reasons := liveSessions(t, ce.trace)
	t.Logf("fast path: %d of %d hits from the shared index (sessions by index reason %v, stale %d)", fast, hits, reasons, l.Stale)
	if fast < minFast || float64(fast) < minShare*float64(hits) {
		t.Errorf("only %d of %d hits came from the shared index; want at least %d and %.0f%%", fast, hits, minFast, minShare*100)
	}
}
