package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// Finding 9: --cache-dir pointing at a symlink is resolved once at start; the
// directory behind it is managed and owner.json names the resolved path.
func TestSymlinkedCacheDir(t *testing.T) {
	real := filepath.Join(tempDir(t), "go-build")
	os.Mkdir(real, 0o777)
	for i := 0; i < 20; i++ {
		putEntry(t, real, 1000, 3*time.Hour)
	}
	link := filepath.Join(tempDir(t), "cache-link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	cfg := fastConfig(t, link, 50_000_000_000)
	stop := startRun(t, cfg)
	waitFor(t, 3*time.Minute, "the linked cache indexed", func() bool {
		st := readState(t, cfg.StateDir)
		return st.Extra.Phase == "ready" && st.Entries != nil && *st.Entries == 40
	})
	stop()
	if o, _, _ := ownerstate.ReadOwner(cfg.StateDir); o.CacheDir != real {
		t.Errorf("owner.json cacheDir %q, want the resolved %q", o.CacheDir, real)
	}
}

// Finding 10: a clean stop says observe in owner.json at once, so readers
// resume without waiting 120 s, and status calls a stopped daemon stale.
func TestCleanStopDisowns(t *testing.T) {
	dir := tempDir(t)
	putEntry(t, dir, 1000, 0)
	cfg := fastConfig(t, dir, 50_000_000_000)
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	waitFor(t, 3*time.Minute, "owner mode in owner.json", func() bool {
		o, ok, _ := ownerstate.ReadOwner(cfg.StateDir)
		return ok && o.Mode == ownerstate.ModeOwner
	})
	if code := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	o, _, _ := ownerstate.ReadOwner(cfg.StateDir)
	if o.Mode != ownerstate.ModeObserve || !ownerstate.Fresh(o.HeartbeatAt, time.Now()) {
		t.Errorf("owner.json after a clean stop: mode %q heartbeat %d; readers must see observe at once", o.Mode, o.HeartbeatAt)
	}
	st, err := ReadStatus(cfg.StateDir, time.Now())
	if err != nil || !st.Stale || st.HeartbeatFresh || st.Extra.Phase != PhaseStopped {
		t.Errorf("status right after a clean stop: stale %v fresh %v phase %q err %v", st.Stale, st.HeartbeatFresh, st.Extra.Phase, err)
	}
	var out bytes.Buffer
	PrintStatus(&out, st, false)
	if !strings.Contains(out.String(), "not running") {
		t.Errorf("status text after a clean stop: %q", out.String())
	}
}

// A brief shared lock on trim.txt (Go reading it) is retried on the next
// tick, not reported as "Go trim not suppressed" for 10 minutes.
func TestTrimLockContention(t *testing.T) {
	dir := tempDir(t)
	putEntry(t, dir, 100, 0)
	trim := filepath.Join(dir, "trim.txt")
	os.WriteFile(trim, []byte("1000"), 0o666)
	f, err := os.Open(trim)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH); err != nil {
		t.Fatal(err)
	}
	cfg := fastConfig(t, dir, 50_000_000_000)
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	waitFor(t, 3*time.Minute, "owner mode", func() bool { return readState(t, cfg.StateDir).Mode == ownerstate.ModeOwner })
	for end := time.Now().Add(1500 * time.Millisecond); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		for _, r := range readState(t, cfg.StateDir).Extra.Reasons {
			if strings.Contains(r, "Go trim not suppressed") {
				t.Fatalf("a 1.5 s shared lock reported as a failure: %q", r)
			}
		}
	}
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	waitFor(t, 3*time.Minute, "trim.txt written after the lock is released", func() bool {
		data, _ := os.ReadFile(trim)
		v, err := strconv.ParseInt(string(data), 10, 64)
		return err == nil && v > time.Now().Unix()-60
	})
	stop()
}

// When the cache directory is replaced (removed and created again), the
// daemon lets go of its lock on the old directory and takes one on the new.
func TestRootReplacedMovesTheLock(t *testing.T) {
	parent := tempDir(t)
	dir := filepath.Join(parent, "go-build")
	os.Mkdir(dir, 0o777)
	putEntry(t, dir, 1000, 0)
	cfg := fastConfig(t, dir, 50_000_000_000)
	// Watch the daemon's own lock calls: probing dir with flock while the
	// daemon tries it would fail its try and push the retry a minute out.
	var takes atomic.Int32
	var holding atomic.Bool
	cfg.OwnerLock = func() (func(), bool, error) {
		release, held, err := cachefs.LockDir(dir)
		if err != nil || !held {
			return release, held, err
		}
		takes.Add(1)
		holding.Store(true)
		return func() { holding.Store(false); release() }, true, nil
	}
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	waitFor(t, 3*time.Minute, "owner mode", func() bool { return readState(t, cfg.StateDir).Mode == ownerstate.ModeOwner })
	old := filepath.Join(parent, "old-go-build")
	if err := os.Rename(dir, old); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(dir, 0o777)
	putEntry(t, dir, 1000, 0)
	waitFor(t, 3*time.Minute, "the lock let go and taken again on the new directory", func() bool {
		return takes.Load() >= 2 && holding.Load()
	})
	lockable := func(p string) bool {
		release, held, err := cachefs.LockDir(p)
		if err == nil && held {
			release()
		}
		return err == nil && held
	}
	if !lockable(old) || lockable(dir) {
		t.Errorf("old directory lockable %v, new directory lockable %v; want the lock moved to the new one", lockable(old), lockable(dir))
	}
	stop()
}

// The test-settings guard compares with the passwd entry's home too: tests
// point HOME at a temp dir, and the real cache must still count as real.
func TestRealCacheByPasswdHome(t *testing.T) {
	home := os.Getenv("POD_GOCACHE_REAL_HOME")
	if home == "" || home == os.Getenv("HOME") {
		t.Skip("HOME is not redirected")
	}
	if !isRealCache(filepath.Join(home, "Library", "Caches", "go-build")) {
		t.Error("the passwd home's go-build is not recognized as the real cache while HOME points elsewhere")
	}
	if isRealCache(tempDir(t)) {
		t.Error("a temp dir counted as the real cache")
	}
}

// D5 and S13 through the CLI: `daemon --cache-dir <dir>/` publishes the
// cleaned path, integer times with heartbeatAt within 2 s of now, exactly the
// documented keys, and plutil reads heartbeatAt as a number.
func TestOwnerJSONFromDaemonMain(t *testing.T) {
	cache := filepath.Join(tempDir(t), "go-build")
	os.Mkdir(cache, 0o777)
	state := tempDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var stderr lockedBuf
	go func() {
		done <- DaemonMain(ctx, []string{"--cache-dir", cache + "/", "--state-dir", state}, &stderr, "9.9.9")
	}()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Minute):
			t.Error("daemon did not stop")
		}
	}()
	path := filepath.Join(state, ownerstate.OwnerFile)
	waitFor(t, 3*time.Minute, "owner.json", func() bool { return exists(path) })
	data, _ := os.ReadFile(path)
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("owner.json %q: %v", data, err)
	}
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if want := []string{"budgetBytes", "cacheDir", "heartbeatAt", "mode", "pid", "schema", "startedAt", "targetBytes", "version"}; !slices.Equal(keys, want) {
		t.Errorf("owner.json keys %v, want %v", keys, want)
	}
	if m["cacheDir"] != cache || m["version"] != "9.9.9" || m["mode"] != "observe" {
		t.Errorf("cacheDir %v version %v mode %v; want %q, 9.9.9, observe", m["cacheDir"], m["version"], m["mode"], cache)
	}
	hb, err := m["heartbeatAt"].(json.Number).Int64()
	if err != nil || hb < time.Now().Unix()-2 || hb > time.Now().Unix()+1 {
		t.Errorf("heartbeatAt %v is not an integer within 2 s of now (%v)", m["heartbeatAt"], err)
	}
	if _, err := m["startedAt"].(json.Number).Int64(); err != nil {
		t.Errorf("startedAt %v is not an integer", m["startedAt"])
	}
	if _, err := exec.LookPath("plutil"); err == nil {
		out, err := exec.Command("plutil", "-extract", "heartbeatAt", "raw", "-o", "-", path).Output()
		if v, perr := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err != nil || perr != nil || v < hb {
			t.Errorf("plutil -extract heartbeatAt: %q %v", out, err)
		}
	}
}
