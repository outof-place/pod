package daemon

import (
	"strings"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
)

func reasonsHave(r *rig, sub string) bool {
	for _, s := range r.state().Extra.Reasons {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// S4a: killed every 10 minutes at 6 GB free, the daemon still gives the disk
// back: no start grace below 15 GB, so each run evicts before it dies.
func TestS4aCrashLoopLowDisk(t *testing.T) {
	r := newRig(t, 40, nil)
	r.place(200, cachesim.Archive, 100_000_000, 3*time.Hour)
	r.place(50, cachesim.Archive, 100_000_000, 5*time.Minute)
	r.setFree(6 * GB)
	r.w.SetMode("owner", true)
	start := r.w.Now()
	recovered := time.Duration(-1)
	for i := 0; i < 18; i++ {
		r.run(10 * time.Minute)
		if recovered < 0 && r.w.FreeNow() >= r.cfg.Limits.DiskFloor-100_004_096 {
			recovered = r.w.Now() - start
		}
		r.start()
	}
	r.noViolations()
	if recovered < 0 || recovered > time.Hour {
		t.Fatalf("free disk %s after 3 h of restarts every 10 minutes", gbf(r.w.FreeNow()))
	}
	if first := r.w.Removals[0].Mono - start; first > 2*time.Minute {
		t.Errorf("first removal %s after start at 6 GB free", first)
	}
	t.Logf("free disk back above %s after %s", gbf(r.cfg.Limits.DiskFloor), recovered)
}

// S11: owner.json and state.json are written in the first cycle, before the
// index is built, and state.json never publishes a size of 0 meanwhile.
func TestS11OwnerBeforeIndex(t *testing.T) {
	r := newRig(t, 41, nil)
	r.place(5000, cachesim.Archive, 1_000_000, 3*time.Hour)
	r.start()
	start, startWall := r.w.Now(), r.w.Wall().Unix()
	r.run(time.Millisecond)
	if len(r.w.Owners) == 0 || r.w.Owners[len(r.w.Owners)-1].Mono-start > time.Second {
		t.Fatal("no owner.json within a second of start")
	}
	if o := r.owner(); o.HeartbeatAt != startWall || o.Schema != 1 || o.CacheDir != "/sim/go-build" {
		t.Errorf("owner.json %+v", o)
	}
	st := r.sink.First
	if st.Extra.Phase != "indexing" || st.SizeBytes != nil || st.TargetBytes != nil || st.WouldEvictBytes != nil {
		t.Errorf("first state.json: phase %q size %v target %v wouldEvict %v", st.Extra.Phase, st.SizeBytes, st.TargetBytes, st.WouldEvictBytes)
	}
	r.run(2 * time.Minute)
	if st := r.state(); st.Extra.Phase != "ready" || st.SizeBytes == nil || *st.SizeBytes == 0 {
		t.Errorf("after indexing: phase %q size %v", st.Extra.Phase, st.SizeBytes)
	}
}

// S23: the first start on a 40 GB cache with 11 GB free. Observe publishes
// target 30 GB and what it would evict; owner mode switched on from that same
// state evicts exactly that, at a rate above the 30 GB/h a busy day fills.
// Both runs start past the start grace, which would otherwise hold the
// budget part back once free disk is above 15 GB (D2).
func TestS23ObservePlanEqualsOwnerRemovals(t *testing.T) {
	fixture := func() *rig {
		r := newRig(t, 23, budget30)
		wl := r.w.NewWorkload(8000)
		for i := 0; r.w.CacheBytes() < 40*GB && i < len(wl.Actions); i++ {
			r.w.Place(wl.Actions[i], time.Duration(r.w.Rand().Int63n(int64(7*24*time.Hour))))
		}
		r.w.SetCapacity(r.w.CacheBytes() + 11*GB)
		r.run(2 * time.Minute)
		return r
	}
	obs := fixture()
	st := obs.state()
	if st.WouldEvictBytes == nil || st.TargetBytes == nil {
		t.Fatalf("observe published no plan: %+v", st)
	}
	size := obs.w.CacheBytes()
	wantTarget := min(30*GB, max(15*GB, size-(15*GB-11*GB)))
	if *st.TargetBytes != wantTarget {
		t.Errorf("target %s, want %s for a %s cache at 11 GB free", gbf(*st.TargetBytes), gbf(wantTarget), gbf(size))
	}
	obs.run(2 * time.Hour)
	if obs.w.Mutations != 0 {
		t.Errorf("observe mode changed %d things in the cache", obs.w.Mutations)
	}
	would := *obs.state().WouldEvictBytes

	own := fixture()
	own.run(2 * time.Hour)
	before := own.w.CacheBytes()
	own.w.SetMode("owner", true)
	own.run(20 * time.Minute)
	own.noViolations()
	evicted := before - own.w.CacheBytes()
	if evicted != would {
		t.Errorf("owner evicted %s, observe said it would evict %s", gbf(evicted), gbf(would))
	}
	t.Logf("cache %s, target %s, would evict %s, owner evicted %s within 20 minutes",
		gbf(size), gbf(*st.TargetBytes), gbf(would), gbf(evicted))
}

// S24: entries dated decades ahead. Observe leaves and reports them; owner
// dates them today once, then evicts those nobody uses after the window,
// while one a build looks up every 10 minutes stays.
func TestS24FutureTimestamps(t *testing.T) {
	setup := func(t *testing.T) (*rig, []*cachesim.Action, *cachesim.Action) {
		r := newRig(t, 24, tinyBudget)
		future := r.place(20, cachesim.Archive, 10_000_000, -70*365*24*time.Hour)
		hot := r.place(1, cachesim.Archive, 10_000_000, -70*365*24*time.Hour)[0]
		var use func()
		use = func() {
			p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: time.Minute})
			r.w.Lookup(p, hot)
			r.w.After(10*time.Minute, use)
		}
		r.w.After(0, use)
		return r, future, hot
	}
	t.Run("observe", func(t *testing.T) {
		r, future, hot := setup(t)
		r.run(10 * time.Minute)
		r.noViolations()
		if r.state().Extra.FutureBytes == 0 || !reasonsHave(r, "future") {
			t.Errorf("future bytes %d, reasons %q", r.state().Extra.FutureBytes, r.state().Extra.Reasons)
		}
		if n := outputsGone(r.w, append(future, hot)); n != 0 || r.w.Mutations != 0 {
			t.Errorf("observe touched future-dated entries: %d gone, %d changes", n, r.w.Mutations)
		}
	})
	t.Run("owner", func(t *testing.T) {
		r, future, hot := setup(t)
		r.warm()
		r.run(4 * time.Hour)
		r.noViolations()
		if n := outputsGone(r.w, future); n != len(future) {
			t.Errorf("%d of %d unused future-dated entries evicted", n, len(future))
		}
		if _, out := hot.Rels(); !r.w.Exists(out) {
			t.Error("the entry a build uses every 10 minutes was evicted")
		}
		if r.state().Extra.FutureBytes != 0 {
			t.Errorf("future bytes %d after normalizing", r.state().Extra.FutureBytes)
		}
	})
}

// S19: the top candidates can't be deleted (chmod 555 bucket, uchg). They
// are skipped and logged once each, counted in status, the target is reached
// from the others, and the refusals are retried hourly, not in a spin.
func TestS19RefusedEntries(t *testing.T) {
	r := newRig(t, 19, nil)
	r.warm()
	stuck := r.place(100, cachesim.Archive, 10_000_000, 6*24*time.Hour)
	for _, a := range stuck {
		act, out := a.Rels()
		r.w.Refuse(act)
		r.w.Refuse(out)
	}
	free := r.place(60, cachesim.Archive, 100_000_000, 3*24*time.Hour)
	r.cfg.Limits.Budget = r.w.CacheBytes() - 5*GB
	r.c.cfg.Limits.Budget = r.cfg.Limits.Budget
	r.run(30 * time.Minute)
	if r.state().Extra.StuckBytes == 0 || !reasonsHave(r, "undeletable") {
		t.Errorf("status: stuck %d reasons %q", r.state().Extra.StuckBytes, r.state().Extra.Reasons)
	}
	r.run(90 * time.Minute)
	r.noViolations()
	if n := outputsGone(r.w, stuck); n != 0 {
		t.Fatalf("%d refused entries gone", n)
	}
	if n := outputsGone(r.w, free); n < 49 {
		t.Errorf("only %d of the eligible entries evicted; target not reached around the stuck ones", n)
	}
	if got := strings.Count(r.log.String(), "refused "); got != len(stuck) {
		t.Errorf("%d refusal log lines for %d stuck entries", got, len(stuck))
	}
	if r.w.RefusedTries > 3*len(stuck) {
		t.Errorf("%d refused attempts in 2 h for %d entries: retrying in a loop", r.w.RefusedTries, len(stuck))
	}
}

// Amendment 4: client temp files are swept in owner mode only when their
// writer is dead and they are 10 minutes old, or 2 hours old regardless.
func TestTempSweep(t *testing.T) {
	setup := func(t *testing.T) (*rig, map[string]bool) {
		r := newRig(t, 44, nil)
		live := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 10 * time.Hour})
		want := map[string]bool{ // rel -> should be swept
			r.w.AddTemp(1, 9001, 5_000_000, 15*time.Minute):  true,
			r.w.AddTemp(2, 9002, 5_000_000, 5*time.Minute):   false,
			r.w.AddTemp(3, live.PID, 5_000_000, time.Hour):   false,
			r.w.AddTemp(4, live.PID, 5_000_000, 3*time.Hour): true,
		}
		return r, want
	}
	t.Run("owner", func(t *testing.T) {
		r, want := setup(t)
		r.w.SetMode("owner", true)
		r.run(2 * time.Minute)
		r.noViolations()
		for rel, swept := range want {
			if r.w.Exists(rel) == swept {
				t.Errorf("%s: exists %v, want swept %v", rel, r.w.Exists(rel), swept)
			}
		}
		if sw := r.state().Extra.TempSwept; sw == nil || sw.Count != 2 || sw.Bytes != 2*5_001_216 {
			t.Errorf("status clientTempSwept %+v", sw)
		}
		if r.state().Evictions.Count != 0 {
			t.Errorf("temp sweeps counted as evictions: %+v", r.state().Evictions)
		}
	})
	t.Run("observe", func(t *testing.T) {
		r, want := setup(t)
		r.run(2 * time.Minute)
		for rel := range want {
			if !r.w.Exists(rel) {
				t.Errorf("%s swept in observe mode", rel)
			}
		}
		if r.state().Extra.TempBytes == 0 {
			t.Error("observe reports no client temp bytes")
		}
	})
}

// S27: owner -> observe stops removals and trim.txt rewrites as soon as the
// switch is noticed and owner.json says so at once; observe -> owner writes
// trim.txt at once and evicts only after the remaining start grace.
func TestS27ModeSwitchTiming(t *testing.T) {
	r := newRig(t, 27, tinyBudget)
	r.place(500, cachesim.Archive, 10_000_000, 3*24*time.Hour)
	r.run(10 * time.Minute)
	switchAt := r.w.Now()
	r.w.SetMode("owner", true)
	r.run(5 * time.Second)
	if len(r.w.TrimWrites) == 0 || r.w.TrimWrites[0]-switchAt > r.cfg.Tick {
		t.Errorf("trim.txt not written at the switch to owner: %v", r.w.TrimWrites)
	}
	r.run(time.Hour)
	if len(r.w.Removals) > 0 {
		t.Fatalf("%d removals inside the start grace after the switch", len(r.w.Removals))
	}
	r.run(time.Hour)
	if len(r.w.Removals) == 0 {
		t.Fatal("nothing removed after the grace")
	}
	r.place(500, cachesim.Archive, 10_000_000, 3*24*time.Hour)
	r.run(10 * time.Second)
	off := r.w.Now()
	beats, trims := len(r.w.Owners), len(r.w.TrimWrites)
	r.w.SetMode("observe", true)
	r.run(7 * time.Hour)
	r.noViolations() // the world flags any removal after the switch is noticed
	if len(r.w.Owners) == beats || r.w.Owners[beats].Mode != "observe" || r.w.Owners[beats].Mono-off > r.cfg.Tick+time.Second {
		t.Errorf("owner.json did not say observe within a cycle of the switch")
	}
	if len(r.w.TrimWrites) != trims {
		t.Errorf("%d trim.txt rewrites after the switch to observe", len(r.w.TrimWrites)-trims)
	}
}

// S27 inside a long batch (hard floor, so full speed with no unit limit; a
// slow disk; many entries): removals stop and owner.json says observe within
// a second of the switch.
func TestS27SwitchInsideBatch(t *testing.T) {
	r := newRig(t, 30, tinyBudget)
	r.warm()
	r.w.OpCost = 200 * time.Microsecond
	r.place(6000, cachesim.Archive, 1_000_000, 3*24*time.Hour)
	r.setFree(7_500_000_000)
	// The world runs scheduled events between the daemon's file system calls.
	off := r.w.Now() + 5*time.Second
	r.w.At(off, func() { r.w.SetMode("observe", true) })
	r.run(time.Minute)
	r.noViolations()
	before, after := 0, 0
	for _, rm := range r.w.Removals {
		switch {
		case rm.Mono > off-100*time.Millisecond && rm.Mono <= off:
			before++
		case rm.Mono > off+time.Second:
			after++
		}
	}
	if before == 0 {
		t.Fatal("no batch running at the switch")
	}
	if after > 0 {
		t.Fatalf("%d removals more than a second after the switch to observe", after)
	}
	for _, b := range r.w.Owners {
		if b.Mono > off {
			if b.Mode != "observe" || b.Mono-off > time.Second {
				t.Errorf("first owner.json after the switch: %s at +%s", b.Mode, b.Mono-off)
			}
			break
		}
	}
}

// S27: `echo owner > mode` truncates before it writes. An owner daemon that
// reads the empty file in between stays owner; a file left invalid does not.
func TestS27TruncateThenWrite(t *testing.T) {
	r := newRig(t, 29, tinyBudget)
	r.warm()
	r.place(3000, cachesim.Archive, 10_000_000, 3*24*time.Hour)
	r.run(10 * time.Second)
	beats, removals := len(r.w.Owners), len(r.w.Removals)
	for i := 0; i < 20; i++ {
		r.w.SetMode("", false)
		r.run(300 * time.Millisecond)
		r.w.SetMode("owner", true)
		r.run(3 * time.Second)
	}
	if r.logHas("mode owner -> observe") {
		t.Fatalf("a mode file empty for 300 ms switched the daemon to observe:\n%s", tail(r.log.String(), 1500))
	}
	for _, b := range r.w.Owners[beats:] {
		if b.Mode != "owner" {
			t.Fatalf("owner.json said %s during the rewrites", b.Mode)
		}
	}
	if len(r.w.Removals) == removals {
		t.Fatal("no removals while the mode file was rewritten: the daemon never had a reason to read it")
	}
	r.w.SetMode("", false)
	r.run(10 * time.Second)
	if r.owner().Mode != "observe" {
		t.Error("a mode file that stays invalid must mean observe")
	}
	r.noViolations()
}

// S17: `go clean -cache` under a running daemon. No error loop; the next
// rescan sees the new entries, they are evicted past the window, and the
// files clean removed are not counted as evictions.
func TestS17GoClean(t *testing.T) {
	r := newRig(t, 17, tinyBudget)
	r.warm()
	r.place(300, cachesim.Archive, 10_000_000, 3*time.Hour)
	r.run(time.Minute)
	before := r.state().Evictions
	r.place(300, cachesim.Archive, 10_000_000, 30*time.Minute)
	r.run(time.Minute)
	cleaned := r.w.CacheBytes()
	r.w.GoClean()
	evAtClean := r.state().Evictions
	r.run(time.Minute)
	// Finding 8: what something else deleted shows in status, with a reason.
	if st := r.state(); st.Extra.VanishedBytes < cleaned || st.Extra.VanishedLastAt == 0 || !reasonsHave(r, "deleted by something else") {
		t.Errorf("after go clean of %s: vanished %s at %d, reasons %q", gbf(cleaned), gbf(st.Extra.VanishedBytes), st.Extra.VanishedLastAt, st.Extra.Reasons)
	}
	fresh := r.place(200, cachesim.Archive, 10_000_000, 0)
	r.run(2 * time.Minute)
	if st := r.state(); st.SizeBytes == nil || *st.SizeBytes != r.w.CacheBytes() {
		t.Fatalf("size after clean and rebuild %v, cache holds %s", st.SizeBytes, gbf(r.w.CacheBytes()))
	}
	if got := r.state().Evictions; got.Count != evAtClean.Count {
		t.Errorf("evictions went from %d to %d with nothing evicted: clean's removals counted", evAtClean.Count, got.Count)
	}
	r.run(2*time.Hour + 10*time.Minute)
	if n := outputsGone(r.w, fresh); n != len(fresh) {
		t.Errorf("%d of %d rebuilt entries evicted past the window", n, len(fresh))
	}
	r.noViolations()
	if strings.Count(r.log.String(), "reindexing") > 3 {
		t.Errorf("reindex loop:\n%s", tail(r.log.String(), 2000))
	}
	_ = before
}
