package daemon

import (
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// stallFS blocks the loop in Lstat while file exists, as a thread that gets
// no CPU makes no progress; mark gets the wall ns each stall begins.
type stallFS struct {
	cachefs.FS
	mark string
	on   atomic.Bool
}

func newStallFS(fs cachefs.FS, file, mark string) *stallFS {
	s := &stallFS{FS: fs, mark: mark}
	go func() {
		for {
			_, err := os.Stat(file)
			s.on.Store(err == nil)
			time.Sleep(5 * time.Millisecond)
		}
	}()
	return s
}

func (s *stallFS) Lstat(rel string) (cachefs.Stat, error) {
	if s.on.Load() {
		os.WriteFile(s.mark, []byte(strconv.FormatInt(time.Now().UnixNano(), 10)), 0o600)
		for s.on.Load() {
			time.Sleep(5 * time.Millisecond)
		}
	}
	return s.FS.Lstat(rel)
}

// slowOwnerSink takes d before each owner.json write, as fsync can on a loaded disk.
type slowOwnerSink struct {
	FileSink
	d time.Duration
}

func (s slowOwnerSink) WriteOwner(o ownerstate.Owner) error {
	time.Sleep(s.d)
	return s.FileSink.WriteOwner(o)
}

// stallLoop makes the helper's loop block in its next Lstat and returns when
// it does, with the wall time the stall began.
func stallLoop(t *testing.T, stall, mark string) time.Time {
	t.Helper()
	if err := os.WriteFile(stall, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var ns int64
	// the mark is created before its content lands
	waitFor(t, time.Minute, "the loop to stall", func() bool {
		data, err := os.ReadFile(mark)
		if err != nil {
			return false
		}
		n, perr := strconv.ParseInt(string(data), 10, 64)
		ns = n
		return perr == nil
	})
	return time.Unix(0, ns)
}

func waitOwnerMode(t *testing.T, state string, pid int) {
	t.Helper()
	waitFor(t, time.Minute, "owner mode from pid "+strconv.Itoa(pid), func() bool {
		o, ok, err := ownerstate.ReadOwner(state)
		return err == nil && ok && o.PID == pid && o.Mode == ownerstate.ModeOwner
	})
}

// ownerWatch is what owner.json did while a test watched it.
type ownerWatch struct {
	maxAge time.Duration // the oldest its last write was at any look (by mtime)
	writes []time.Time   // distinct mtimes seen
	bad    string        // the first content that was not owner from the pid
}

func (w ownerWatch) last() time.Time { return w.writes[len(w.writes)-1] }

func watchOwner(t *testing.T, state string, pid int, d time.Duration) ownerWatch {
	t.Helper()
	path := filepath.Join(state, ownerstate.OwnerFile)
	var w ownerWatch
	for end := time.Now().Add(d); ; time.Sleep(10 * time.Millisecond) {
		now := time.Now()
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if m := st.ModTime(); len(w.writes) == 0 || !m.Equal(w.last()) {
			w.writes = append(w.writes, m)
			o, ok, err := ownerstate.ReadOwner(state)
			if w.bad == "" && (err != nil || !ok || o.Mode != ownerstate.ModeOwner || o.PID != pid) {
				w.bad = fmt.Sprintf("%+v (ok %v, err %v)", o, ok, err)
			}
		}
		w.maxAge = max(w.maxAge, now.Sub(w.last()))
		if now.After(end) {
			return w
		}
	}
}

// 18.10, load 100 to 168: the loop's thread sat in the background band
// waiting minutes for the CPU, owner.json's heartbeat came only from it, and
// go-cache-trim.sh took the cache back from a live, healthy owner. Scaled
// 1/60 (heartbeat 500 ms, so the readers' 120 s is 2 s): a loop stalled for 4
// minutes, inside the progress limit (5 minutes in production, 10 here for
// margin on a loaded Mac), keeps owner.json fresh the whole time, written in
// owner mode by the same daemon.
func TestHeartbeatSurvivesStarvedLoop(t *testing.T) {
	const hb = 500 * time.Millisecond
	cache, state, ctl := tempDir(t), tempDir(t), tempDir(t)
	putEntry(t, cache, 100, 3*time.Hour)
	setMode(t, state, "owner")
	stall, mark := filepath.Join(ctl, "stall"), filepath.Join(ctl, "stalled")
	p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9, Heartbeat: hb, ProgressLimit: 20 * hb, StallFile: stall, StallMark: mark}, nil)
	pid := p.cmd.Process.Pid
	waitOwnerMode(t, state, pid)
	stallLoop(t, stall, mark)
	w := watchOwner(t, state, pid, 8*hb)
	os.Remove(stall)
	if w.maxAge > 4*hb {
		t.Errorf("owner.json's heartbeat reached %s old while the loop stalled for %s; readers give up past %s (%d writes)", w.maxAge.Round(time.Millisecond), 8*hb, 4*hb, len(w.writes))
	}
	if w.bad != "" {
		t.Errorf("owner.json during the stall: %s", w.bad)
	}
	if code := p.term(t); code != 0 {
		t.Errorf("exit %d; stderr:\n%s", code, tail(p.stderr.String(), 2000))
	}
	if !strings.Contains(p.stderr.String(), "the heartbeat goroutine keeps owner.json fresh") {
		t.Errorf("no stall line in the log:\n%s", tail(p.stderr.String(), 2000))
	}
}

// S12a with the heartbeat goroutine: a loop wedged past the progress limit
// stops the heartbeat, so owner.json goes stale for readers within limit +
// 120 s (scaled: heartbeat 500 ms, readers' limit 2 s, progress limit 2 s)
// and gets no fresh owner heartbeat while the loop stays wedged. Within the
// limit the goroutine still writes; once the loop moves the heartbeat resumes.
func TestHeartbeatStopsWhenLoopWedges(t *testing.T) {
	const hb, limit = 500 * time.Millisecond, 2 * time.Second
	cache, state, ctl := tempDir(t), tempDir(t), tempDir(t)
	putEntry(t, cache, 100, 3*time.Hour)
	setMode(t, state, "owner")
	stall, mark := filepath.Join(ctl, "stall"), filepath.Join(ctl, "stalled")
	p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9, Heartbeat: hb, ProgressLimit: limit, StallFile: stall, StallMark: mark}, nil)
	pid := p.cmd.Process.Pid
	waitOwnerMode(t, state, pid)
	wedged := stallLoop(t, stall, mark)
	w := watchOwner(t, state, pid, limit+4*hb+2*time.Second)
	last := w.last()
	if d := last.Sub(wedged); d > limit+hb {
		t.Errorf("owner.json written %s into the wedge, progress limit %s", d.Round(time.Millisecond), limit)
	}
	if d := last.Sub(wedged); d < hb {
		t.Errorf("the heartbeat stopped %s into the wedge; within the %s limit it must go on", d.Round(time.Millisecond), limit)
	}
	o, _, _ := ownerstate.ReadOwner(state)
	if o.HeartbeatAt > wedged.Add(limit).Unix()+1 || time.Since(last) <= 4*hb {
		t.Errorf("readers still see a fresh owner %s after the wedge began: heartbeatAt %d, last write %s ago", time.Since(wedged).Round(time.Millisecond), o.HeartbeatAt, time.Since(last).Round(time.Millisecond))
	}
	if w.bad != "" {
		t.Errorf("owner.json during the wedge: %s", w.bad)
	}
	os.Remove(stall)
	waitFor(t, 10*time.Second, "heartbeats after the wedge", func() bool {
		st, err := os.Stat(filepath.Join(state, ownerstate.OwnerFile))
		o, ok, _ := ownerstate.ReadOwner(state)
		return err == nil && st.ModTime().After(last) && ok && o.Mode == ownerstate.ModeOwner && ownerstate.Fresh(o.HeartbeatAt, time.Now())
	})
	time.Sleep(2 * hb) // the goroutine's next look, which logs the resume
	if code := p.term(t); code != 0 {
		t.Errorf("exit %d", code)
	}
	if log := p.stderr.String(); !strings.Contains(log, "heartbeat stopped") || !strings.Contains(log, "heartbeat resumed") {
		t.Errorf("no stop and resume lines in the log:\n%s", tail(log, 2000))
	}
}

// SIGTERM while the heartbeat goroutine is due (it is every millisecond, and
// each owner.json write takes 2 ms, so a refresh is often in flight):
// owner.json ends in observe from the stopped daemon every time, and the
// exit is 0, so the race detector (the helper is this test binary, built
// with -race under -race) found nothing either.
func TestSigtermWhileHeartbeatDue(t *testing.T) {
	runs := 24
	if testing.Short() {
		runs = 4
	}
	for i := range runs {
		cache, state := tempDir(t), tempDir(t)
		setMode(t, state, "owner")
		p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9, Heartbeat: time.Millisecond, SlowOwnerWrite: 2 * time.Millisecond}, nil)
		pid := p.cmd.Process.Pid
		waitOwnerMode(t, state, pid)
		time.Sleep(time.Duration(rand.IntN(50)) * time.Millisecond)
		code := p.term(t)
		o, ok, err := ownerstate.ReadOwner(state)
		if code != 0 || err != nil || !ok || o.Mode != ownerstate.ModeObserve || o.PID != pid {
			t.Fatalf("run %d: exit %d, owner.json %+v (ok %v, err %v), want observe from pid %d; stderr:\n%s", i, code, o, ok, err, pid, tail(p.stderr.String(), 2000))
		}
	}
}

// Belt and braces: a loop that finds owner.json's heartbeat over twice
// HeartbeatEvery old (every file system call here takes 70 s and the
// simulation has no heartbeat goroutine) leaves the background band, says
// why, and returns to it 10 minutes after the last such find.
func TestLoopLeavesBandWhenHeartbeatWentOld(t *testing.T) {
	r := newRig(t, 84, nil)
	r.place(200, cachesim.Archive, 1_000_000, 3*time.Hour)
	r.w.SetMode("owner", true)
	r.run(5 * time.Minute)
	if r.logHas("loop behind") {
		t.Fatalf("behind before the slow disk:\n%s", tail(r.log.String(), 2000))
	}
	r.w.OpCost = 70 * time.Second
	r.run(5 * time.Minute)
	r.w.OpCost = 20 * time.Microsecond
	r.run(time.Minute)
	if line := lastLine(r.log.String(), "loop "); !strings.Contains(line, "loop behind (owner.json heartbeat was ") {
		t.Fatalf("last loop line %q, want out of the band for an old heartbeat:\n%s", line, tail(r.log.String(), 2000))
	}
	r.run(15 * time.Minute)
	if line := lastLine(r.log.String(), "loop "); !strings.HasSuffix(strings.TrimSpace(line), "background band again") {
		t.Errorf("last loop line %q, want back in the band:\n%s", line, tail(r.log.String(), 2000))
	}
	r.noViolations()
}
