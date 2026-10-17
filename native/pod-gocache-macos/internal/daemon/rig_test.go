package daemon

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/procscan"
)

const GB = evict.GB

// simStart is the simulated wall clock at the start of every run.
var simStart = time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)

// ringLog keeps the last part of a long simulated run's log.
type ringLog struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (r *ringLog) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.max {
		r.buf = append(r.buf[:0], r.buf[len(r.buf)-r.max/2:]...)
	}
	return len(p), nil
}

func (r *ringLog) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// rig is the daemon core on a simulated machine.
type rig struct {
	t    testing.TB
	w    *cachesim.World
	sink *cachesim.Sink
	cfg  Config
	c    *core
	log  *ringLog
	ev   []Eviction
}

func simLimits(l evict.Limits) cachesim.Limits {
	return cachesim.Limits{
		Window: l.Window, HardWindow: l.HardWindow, EmergencyWindow: l.EmergencyWindow,
		ProcessMargin: l.ProcessMargin, ProcessAgeCap: l.ProcessAgeCap, GoRunCap: l.GoRunCap, Budget: l.Budget,
		DiskFloor: l.DiskFloor, HardFloor: l.HardFloor, EmergencyFloor: l.EmergencyFloor,
		Hysteresis: l.Hysteresis, ProcLag: 10 * time.Second,
	}
}

// floors8and6 pins the hard and emergency floors a scenario's numbers were
// worked out for.
func floors8and6(c *Config) { c.Limits.HardFloor, c.Limits.EmergencyFloor = 8*GB, 6*GB }

func newRig(t testing.TB, seed int64, tweak func(*Config)) *rig {
	r := buildRig(t, seed, simStart, tweak)
	r.start()
	return r
}

// buildRig is newRig with the world's wall clock starting at start and the
// daemon not started yet.
func buildRig(t testing.TB, seed int64, start time.Time, tweak func(*Config)) *rig {
	l := evict.Defaults()
	r := &rig{t: t, log: &ringLog{max: 1 << 20}}
	cfg := Config{CacheDir: "/sim/go-build", StateDir: "/sim/state", Version: "test", Limits: l}
	if tweak != nil {
		tweak(&cfg)
	}
	r.w = cachesim.New(seed, start, simLimits(cfg.Limits))
	r.sink = &cachesim.Sink{W: r.w}
	cfg.FS, cfg.Disk, cfg.Clock = r.w, r.w, r.w
	if cfg.Procs == nil {
		cfg.Procs = r.w
	}
	cfg.Sink, cfg.Mode, cfg.Prio, cfg.Log = r.sink, cachesim.ModeSource{W: r.w}, cachesim.Prio{W: r.w}, r.log
	cfg.OnEvict = func(e Eviction) { r.ev = append(r.ev, e) }
	var err error
	if r.cfg, err = cfg.withDefaults(); err != nil {
		t.Fatal(err)
	}
	return r
}

// start (re)starts the daemon on the same machine, like launchd after a kill.
func (r *rig) start() {
	r.c = newCore(r.cfg, NewLogger(r.log, r.w.Wall))
	r.w.DaemonStarted()
	r.w.Note("daemon start")
}

func (r *rig) run(d time.Duration) { r.w.Run(r.w.Now()+d, r.c.tick) }

// state is the last state.json the daemon wrote.
func (r *rig) state() ownerstate.State { return r.sink.Last }

func (r *rig) owner() ownerstate.Owner { return r.sink.Owner }

// noViolations fails on any invariant the world saw broken.
func (r *rig) noViolations() {
	r.t.Helper()
	if len(r.w.Violations) > 0 {
		var ev strings.Builder
		for _, v := range r.w.Violations[:min(3, len(r.w.Violations))] {
			for _, e := range r.ev {
				if strings.Contains(v, e.Rel) {
					fmt.Fprintf(&ev, "daemon: %s wall=%s recency=%s age=%s window=%s stage=%d tier=%s\n", e.Rel,
						time.Unix(0, e.Wall).UTC().Format(time.TimeOnly), time.Unix(0, e.Recency).UTC().Format(time.TimeOnly), e.Age, e.Window, e.Stage, e.Tier)
				}
			}
		}
		r.t.Fatalf("%d invariant violations, first:\n%s\n%sjournal:\n%s\nlog tail:\n%s", len(r.w.Violations),
			strings.Join(r.w.Violations[:min(10, len(r.w.Violations))], "\n"), ev.String(), strings.Join(r.w.Journal, "\n"), tail(r.log.String(), 3000))
	}
}

// unexplainedFailures are build failures outside the two documented classes:
// a relaxed (< 9 GB free) tier deleting what a build held, and the put race.
func (r *rig) unexplainedFailures() []cachesim.Failure {
	var out []cachesim.Failure
	for _, f := range r.w.Failures {
		if f.Class == "concurrent-put" {
			continue
		}
		if rm, ok := r.removalBefore(f.Rel, f.At); ok && rm.FreeAtCut < r.cfg.Limits.HardFloor+r.cfg.Limits.Hysteresis {
			continue
		}
		out = append(out, f)
	}
	return out
}

// removalBefore is the daemon's last removal of rel (or its executable) at
// or before awake time at.
func (r *rig) removalBefore(rel string, at time.Duration) (cachesim.Removal, bool) {
	for i := len(r.w.Removals) - 1; i >= 0; i-- {
		if r.w.Removals[i].Mono > at {
			continue
		}
		if r.w.Removals[i].Rel == rel || strings.HasPrefix(r.w.Removals[i].Rel, rel+"/") || strings.HasPrefix(rel, r.w.Removals[i].Rel+"/") {
			return r.w.Removals[i], true
		}
	}
	return cachesim.Removal{}, false
}

func (r *rig) noUnexplainedFailures() {
	r.t.Helper()
	if fs := r.unexplainedFailures(); len(fs) > 0 {
		var b strings.Builder
		for _, f := range fs[:min(5, len(fs))] {
			rm, ok := r.removalBefore(f.Rel, f.At)
			fmt.Fprintf(&b, "%+v removal=%+v(%v)\n", f, rm, ok)
		}
		r.t.Fatalf("%d build failures, first:\n%slog tail:\n%s", len(fs), b.String(), tail(r.log.String(), 3000))
	}
}

// maxHeartbeatGap is the longest awake time between owner.json writes.
func (r *rig) maxHeartbeatGap(from time.Duration) time.Duration {
	var gap time.Duration
	prev := time.Duration(-1)
	for _, b := range r.w.Owners {
		if b.Mono < from {
			continue
		}
		if prev >= 0 {
			gap = max(gap, b.Mono-prev)
		}
		prev = b.Mono
	}
	return gap
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func gbf(n int64) string { return fmt.Sprintf("%.2fGB", float64(n)/1e9) }

// noProcs is a process table that never shows anything (sabotage runs).
type noProcs struct{}

func (noProcs) List() ([]procscan.Proc, error) { return nil, nil }

// warm switches to owner mode and runs past the start grace.
func (r *rig) warm() {
	r.w.SetMode("owner", true)
	r.run(r.cfg.Limits.Window + time.Minute)
}

// place puts n new actions of kind and size into the cache, last used age ago.
func (r *rig) place(n int, kind cachesim.ActKind, size int64, age time.Duration) []*cachesim.Action {
	out := make([]*cachesim.Action, n)
	for i := range out {
		out[i] = r.w.NewAction(kind, size)
		r.w.Place(out[i], age)
	}
	return out
}

// setFree makes free disk n bytes now, with the cache as it is.
func (r *rig) setFree(n int64) {
	r.w.SetExternal(0)
	r.w.SetExternal(r.w.FreeNow() - n)
}

func outputsGone(w *cachesim.World, as []*cachesim.Action) int {
	n := 0
	for _, a := range as {
		if _, out := a.Rels(); !w.Exists(out) {
			n++
		}
	}
	return n
}

func (r *rig) logHas(sub string) bool { return strings.Contains(r.log.String(), sub) }
