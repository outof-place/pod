package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

// A daemon that stops releases the shared files and the publisher lock, so
// the next daemon on the cache publishes (and may delete) at once, also when
// it runs in the same process, as Pod's tests and the realgo harness do.
func TestRestartedDaemonPublishes(t *testing.T) {
	cache, live := tempDir(t), tempDir(t)
	for range 20 {
		putEntry(t, cache, 1000, time.Hour)
	}
	for round := range 2 {
		cfg := fastConfig(t, cache, 60_000_000_000)
		cfg.LiveRoot = live
		setMode(t, cfg.StateDir, "owner")
		stop := startRun(t, cfg)
		waitFor(t, time.Minute, fmt.Sprintf("daemon %d to publish", round+1), func() bool {
			l := readState(t, cfg.StateDir).Extra.Live
			return l != nil && l.Reason == "" && l.Entries == 20
		})
		if code := stop(); code != ExitOK {
			t.Fatalf("round %d: exit %d", round, code)
		}
	}
}

// fastHit opens a client session and reports whether id comes from the
// shared index.
func fastHit(cache string, id [32]byte) bool {
	c := livestate.OpenClient(cache, os.Getpid())
	defer c.Close()
	s := store.Open(cache)
	s.SetLive(c)
	var h store.Hit
	return c.Index == livestate.ReasonOK && s.Get(&id, &h) && h.Fast
}

// Gate fix 1: the live directory deleted mid-run (rm -rf <root>/v1-*). The
// daemon (another process, at 100 ms ticks) notices on its next tick and
// recreates the files: new sessions get index hits again. A client that
// claimed its slot in the deleted clients file still pins: the output it was
// served stays past the window, while an entry used as recently and never
// pinned goes.
func TestLiveDirDeletedMidRun(t *testing.T) {
	cache, live, state := tempDir(t), tempDir(t), tempDir(t)
	t.Setenv(livestate.EnvRoot, live)
	for range 20 {
		putEntry(t, cache, 1000, 3*time.Hour)
	}
	x := putEntry(t, cache, 1000, 0) // served to the running client
	y := putEntry(t, cache, 1000, 0) // as recent, never served
	z := putEntry(t, cache, 1000, 0) // looked up by later sessions
	setMode(t, state, "owner")
	const window = 15 * time.Second
	spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, LiveRoot: live, Free: 12_000_000_000, Window: window, TickMs: 100}, nil)
	waitFor(t, time.Minute, "the index to be published", func() bool { return fastHit(cache, z.id) })

	running := livestate.OpenClient(cache, os.Getpid())
	defer running.Close()
	s := store.Open(cache)
	s.SetLive(running)
	var h store.Hit
	if !s.Get(&x.id, &h) || !h.Fast {
		t.Fatalf("the running client got no index hit on x (index %v)", running.Index)
	}

	id, _ := livestate.StatCache(cache)
	if err := os.RemoveAll(livestate.Dir(live, id)); err != nil {
		t.Fatal(err)
	}
	deleted := time.Now()
	waitFor(t, 30*time.Second, "index hits for new sessions after the deletion", func() bool { return fastHit(cache, z.id) })
	t.Logf("index hits again %s after the deletion (ticks are 100 ms)", time.Since(deleted).Round(time.Millisecond))
	// rm -rf removes the files one at a time; a tick in between repairs the
	// first one missing, a later tick the rest. state.json follows on the next
	// heartbeat (10 ticks).
	waitFor(t, 5*time.Second, "status to say what was recreated", func() bool {
		l := readState(t, state).Extra.Live
		return l != nil && l.Repairs > 0 && strings.Contains(l.LastRepair, "no such file or directory")
	})

	_, xOut := x.paths(cache)
	_, yOut := y.paths(cache)
	waitFor(t, 2*window+time.Minute, "y (idle past the window, unpinned) to be evicted", func() bool { return !exists(yOut) })
	if !exists(xOut) {
		t.Fatal("x's output was evicted although the client served it from before the deletion still runs")
	}
	if l := readState(t, state).Extra.Live; l == nil || l.ClientsFiles != 2 || l.Pinning == 0 {
		t.Errorf("the deleted clients file is not drained beside the new one: %+v", l)
	}
	if names, _ := filepath.Glob(filepath.Join(live, "v1-*", ".*")); len(names) != 0 {
		t.Errorf("temp files left in the live directory: %v", names)
	}
}

// Gate fix 7: only the cache's owner takes the publisher lock. An observe
// daemon that started first shares nothing, so the owner publishes and
// removes as if it were alone.
func TestObserveDaemonNeverTakesThePublisherLock(t *testing.T) {
	cache, live := tempDir(t), tempDir(t)
	for range 20 {
		putEntry(t, cache, 1000, 3*time.Hour)
	}
	obs := fastConfig(t, cache, 12_000_000_000)
	obs.LiveRoot, obs.ObserveOnly = live, true
	startRun(t, obs)
	waitFor(t, time.Minute, "the observe daemon to index", func() bool { return readState(t, obs.StateDir).Extra.Phase == "ready" })
	if l := readState(t, obs.StateDir).Extra.Live; l == nil || l.Reason != notOwner || l.Entries != 0 {
		t.Fatalf("observe daemon shares state: %+v", l)
	}
	own := fastConfig(t, cache, 12_000_000_000)
	own.LiveRoot = live
	setMode(t, own.StateDir, "owner")
	startRun(t, own)
	waitFor(t, time.Minute, "the owner to publish and remove", func() bool {
		st := readState(t, own.StateDir)
		return st.Extra.Live != nil && st.Extra.Live.Reason == "" && st.Evictions.Count > 0
	})
}

// Gate fix 6: state.json shows what client sessions did (index hits, disk
// hits, misses, puts), why sessions went without the index, and which
// clients pin, with the go process each serves.
func TestStatusShowsClientSessions(t *testing.T) {
	cache, live, state := tempDir(t), tempDir(t), tempDir(t)
	t.Setenv(livestate.EnvRoot, live)
	var ids []entryIDs
	for range 40 {
		ids = append(ids, putEntry(t, cache, 1000, 0))
	}
	setMode(t, state, "owner")
	spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, LiveRoot: live, Free: 60_000_000_000, Window: time.Hour, TickMs: 50}, nil)
	waitFor(t, time.Minute, "the index to be published", func() bool { return fastHit(cache, ids[0].id) })

	c := livestate.OpenClient(cache, 4242)
	s := store.Open(cache)
	s.SetLive(c)
	var h store.Hit
	for _, e := range ids {
		s.Get(&e.id, &h)
	}
	missing := randID()
	s.Get(&missing, &h)
	c.Close() // reports; the slot stays held while this process lives
	want := c.Fast
	if want == 0 {
		t.Fatal("no index hit to count")
	}
	waitFor(t, 30*time.Second, "the session's counts in state.json", func() bool {
		l := readState(t, state).Extra.Live
		if l == nil || l.Sessions.FastHits < want || l.Sessions.Misses == 0 || l.Sessions.IndexReasons["ok"] == 0 {
			return false
		}
		for _, p := range l.PinningPIDs {
			if p.PID == os.Getpid() && p.GoPID == 4242 && p.Pins > 0 {
				return true
			}
		}
		return false
	})
}
