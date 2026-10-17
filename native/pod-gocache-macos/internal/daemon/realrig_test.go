package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// Helpers for tests on a real temp directory with the real filesystem code.

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// fixedDisk reports a free-disk figure the test sets.
type fixedDisk struct{ free atomic.Int64 }

func newDisk(free int64) *fixedDisk {
	d := &fixedDisk{}
	d.free.Store(free)
	return d
}

func (d *fixedDisk) Free() (int64, error) { return d.free.Load(), nil }

func tempDir(t testing.TB) string {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

type entryIDs struct{ id, out [32]byte }

func randID() [32]byte {
	var id [32]byte
	rand.Read(id[:])
	return id
}

func setAge(t testing.TB, path string, age time.Duration) {
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

// putEntry writes an -a and its output file the way cmd/go does, last used
// age ago.
func putEntry(t testing.TB, dir string, size int, age time.Duration) entryIDs {
	e := entryIDs{randID(), randID()}
	ap := filepath.Join(dir, cachefs.EntryRel(e.id, cachefs.KindAction))
	dp := filepath.Join(dir, cachefs.EntryRel(e.out, cachefs.KindOutput))
	for _, p := range []string{ap, dp} {
		os.MkdirAll(filepath.Dir(p), 0o777)
	}
	if err := os.WriteFile(dp, make([]byte, size), 0o666); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf("v1 %x %x %20d %20d\n", e.id, e.out, size, time.Now().UnixNano())
	if err := os.WriteFile(ap, []byte(line), 0o666); err != nil {
		t.Fatal(err)
	}
	setAge(t, dp, age)
	setAge(t, ap, age)
	return e
}

// putExec writes an executable entry: an -d directory holding one file.
func putExec(t testing.TB, dir string, size int, age time.Duration) entryIDs {
	e := entryIDs{randID(), randID()}
	ap := filepath.Join(dir, cachefs.EntryRel(e.id, cachefs.KindAction))
	dd := filepath.Join(dir, cachefs.EntryRel(e.out, cachefs.KindOutput))
	os.MkdirAll(filepath.Dir(ap), 0o777)
	os.MkdirAll(dd, 0o777)
	if err := os.WriteFile(filepath.Join(dd, "prog"), make([]byte, size), 0o777); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf("v1 %x %x %20d %20d\n", e.id, e.out, size, time.Now().UnixNano())
	os.WriteFile(ap, []byte(line), 0o666)
	setAge(t, filepath.Join(dd, "prog"), age)
	setAge(t, dd, age)
	setAge(t, ap, age)
	return e
}

func (e entryIDs) paths(dir string) (action, output string) {
	return filepath.Join(dir, cachefs.EntryRel(e.id, cachefs.KindAction)), filepath.Join(dir, cachefs.EntryRel(e.out, cachefs.KindOutput))
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

type fileState struct {
	typ          fs.FileMode
	size         int64
	mtime, ctime int64
	mode         fs.FileMode
	ino          uint64
}

// snapshot records every name under dir with what a write, chtimes or
// replace would change.
func snapshot(t testing.TB, dir string) map[string]fileState {
	m := map[string]fileState{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		var st syscall.Stat_t
		if syscall.Lstat(p, &st) != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		m[rel] = fileState{typ: d.Type(), size: st.Size, mtime: st.Mtimespec.Nano(), ctime: st.Ctimespec.Nano(), mode: fs.FileMode(st.Mode), ino: st.Ino}
		return nil
	})
	return m
}

// diffSnap lists names that appeared, vanished or changed.
func diffSnap(a, b map[string]fileState) (added, removed, changed []string) {
	for k, v := range b {
		if old, ok := a[k]; !ok {
			added = append(added, k)
		} else if old != v && k != "." {
			changed = append(changed, k)
		}
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			removed = append(removed, k)
		}
	}
	return
}

// fastConfig is a daemon on dir with second-scale timing.
func fastConfig(t testing.TB, cacheDir string, free int64) Config {
	l := evict.Defaults()
	l.Budget = 1
	l.Window, l.HardWindow, l.EmergencyWindow = time.Minute, 30*time.Second, 15*time.Second
	return Config{
		CacheDir: cacheDir, StateDir: tempDir(t), Version: "test", Limits: l,
		Tick: 20 * time.Millisecond, HeartbeatEvery: 200 * time.Millisecond, ModeEvery: 50 * time.Millisecond,
		IdleRelist: 50 * time.Millisecond, PressureRelist: 50 * time.Millisecond, PlanEvery: 50 * time.Millisecond,
		ProcEvery: 100 * time.Millisecond, OutputSettle: 100 * time.Millisecond,
		Disk: newDisk(free), Procs: noProcs{}, Log: &lockedBuf{},
	}
}

func setMode(t testing.TB, stateDir, mode string) {
	if mode == "" {
		os.Remove(filepath.Join(stateDir, ownerstate.ModeFile))
		return
	}
	if err := os.WriteFile(filepath.Join(stateDir, ownerstate.ModeFile), []byte(mode), 0o600); err != nil {
		t.Fatal(err)
	}
}

// startRun runs the daemon in this process; stop cancels it and returns the
// exit code.
func startRun(t testing.TB, cfg Config) (stop func() int) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- Run(ctx, cfg) }()
	var once sync.Once
	code := -1
	stop = func() int {
		once.Do(func() {
			cancel()
			select {
			case code = <-done:
			case <-time.After(time.Minute): // a loaded machine finishes the tick late
				t.Error("daemon did not stop")
			}
		})
		return code
	}
	t.Cleanup(func() { stop() })
	return stop
}

func waitFor(t testing.TB, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", d, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readState(t testing.TB, dir string) ownerstate.State {
	st, _, _ := ownerstate.ReadState(dir)
	return st
}
