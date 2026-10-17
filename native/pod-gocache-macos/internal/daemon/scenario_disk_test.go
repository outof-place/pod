package daemon

import (
	"strings"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
)

// minFree samples the true free disk every second from now until until.
func minFree(w *cachesim.World, until time.Duration) *int64 {
	m := w.FreeNow()
	var sample func()
	sample = func() {
		m = min(m, w.FreeNow())
		if w.Now() < until {
			w.After(time.Second, sample)
		}
	}
	w.After(0, sample)
	return &m
}

func evictedBytes(w *cachesim.World) int64 {
	var n int64
	for _, rm := range w.Removals {
		n += rm.Bytes
	}
	return n
}

// S5: the 2026-10-11 emergency. 12 GB free, 34 GB cache; builds add 1 GB a
// minute for 25 minutes while something outside the cache writes 10 GB in 3
// minutes. Free disk never reaches zero, and below 6 GB eviction works with
// the 15 minute window at full speed.
func TestS5EmergencyReplay(t *testing.T) {
	r := newRig(t, 50, nil)
	rng := r.w.Rand()
	for i := 0; i < 340; i++ {
		r.place(1, cachesim.Archive, 100_000_000, time.Duration(2+rng.Intn(160))*time.Hour)
	}
	r.w.SetCapacity(r.w.CacheBytes() + 12*GB)
	r.w.SetMode("owner", true)
	r.run(time.Minute)
	start := r.w.Now()
	low := minFree(r.w, start+40*time.Minute)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 25 * time.Minute})
	for m := 0; m < 25; m++ {
		r.w.At(start+time.Duration(m)*time.Minute, func() { r.place(10, cachesim.Archive, 100_000_000, 0) })
	}
	ext := int64(0)
	for s := 0; s < 30; s++ {
		r.w.At(start+5*time.Minute+time.Duration(s)*6*time.Second, func() {
			ext += 10 * GB / 30
			r.w.SetExternal(ext)
		})
	}
	r.run(40 * time.Minute)
	_ = p
	r.noViolations()
	if *low <= 0 {
		t.Fatalf("free disk reached %s\n%s", gbf(*low), tail(r.log.String(), 6000))
	}
	emergency := 0
	for _, e := range r.ev {
		if e.Tier == evict.Emergency && e.Stage == evict.StageEmergency {
			emergency++
			if e.Window != r.cfg.Limits.EmergencyWindow {
				t.Fatalf("emergency eviction with window %s", e.Window)
			}
		}
	}
	t.Logf("lowest free %s, evicted %s, %d emergency-window removals, free now %s",
		gbf(*low), gbf(evictedBytes(r.w)), emergency, gbf(r.w.FreeNow()))
}

// S5: when nothing is evictable the log and status say so at once.
func TestS5NothingEvictable(t *testing.T) {
	r := newRig(t, 51, nil)
	r.w.SetMode("owner", true)
	r.run(time.Minute)
	r.place(200, cachesim.Archive, 100_000_000, 5*time.Minute)
	r.setFree(5 * GB)
	r.run(30 * time.Second)
	if !r.logHas("cannot keep up") {
		t.Errorf("no 'cannot keep up' line in the log:\n%s", tail(r.log.String(), 2000))
	}
	found := false
	for _, s := range r.state().Extra.Reasons {
		found = found || strings.Contains(s, "cannot keep up")
	}
	if !found {
		t.Errorf("status reasons %q", r.state().Extra.Reasons)
	}
	r.noViolations()
}

// S6: at 7.9 GB free, entries idle > 2 h go first; the relaxed 30 minute
// window serves only the climb back to 9 GB, and within it entries idle
// over an hour go before those idle 30 to 60 minutes.
func TestS6HardFloorOrder(t *testing.T) {
	for _, tc := range []struct {
		name string
		old  int // 100 MB entries idle > 2 h
	}{{"enough-old", 30}, {"little-old", 5}} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, 60, floors8and6)
			r.w.SetMode("owner", true)
			r.run(time.Minute)
			rng := r.w.Rand()
			for i := 0; i < tc.old; i++ {
				r.place(1, cachesim.Archive, 100_000_000, time.Duration(130+rng.Intn(600))*time.Minute)
			}
			for i := 0; i < 60; i++ {
				r.place(1, cachesim.Archive, 100_000_000, time.Duration(61+rng.Intn(59))*time.Minute)
			}
			for i := 0; i < 57; i++ {
				r.place(1, cachesim.Archive, 100_000_000, time.Duration(31+rng.Intn(29))*time.Minute)
			}
			ent := r.place(1, cachesim.Archive, 245_000_000, 40*time.Minute)[0]
			r.place(150, cachesim.Archive, 100_000_000, 10*time.Minute)
			r.setFree(7_900_000_000)
			r.run(5 * time.Minute)
			r.noViolations()
			if _, out := ent.Rels(); !r.w.Exists(out) {
				t.Error("the 245 MB archive idle 40 minutes was evicted")
			}
			var relaxed, maxEntry int64
			youngSeen := false
			for _, e := range r.ev {
				maxEntry = max(maxEntry, e.Bytes)
				if e.Stage != evict.StageNormal {
					relaxed += e.Bytes
				}
				if !strings.HasSuffix(e.Rel, "-a") {
					continue
				}
				if e.Age <= time.Hour {
					youngSeen = true
				} else if youngSeen {
					t.Fatalf("%s idle %s removed after an entry idle under an hour", e.Rel, e.Age)
				}
			}
			if relaxed > 9*GB-7_900_000_000+maxEntry {
				t.Errorf("relaxed window freed %s, more than the climb to 9 GB plus one entry", gbf(relaxed))
			}
			if tc.old == 30 && relaxed > 0 {
				t.Errorf("relaxed window used (%s) although idle > 2 h entries covered the climb", gbf(relaxed))
			}
			t.Logf("free now %s, relaxed %s, removals %d", gbf(r.w.FreeNow()), gbf(relaxed), len(r.ev))
		})
	}
}

// S7: removals that give back no disk (an APFS snapshot). Eviction stays
// within the deficit plus one entry, pauses with a log line, and at 6 GB
// free the cache is not walked down to nothing.
func TestS7NoEffect(t *testing.T) {
	r := newRig(t, 70, nil)
	r.w.SetMode("owner", true)
	r.run(time.Minute)
	r.place(299, cachesim.Archive, 100_000_000, 5*time.Hour) // just under the budget
	r.w.SetCapacity(r.w.CacheBytes() + 12*GB)
	r.w.FreeIgnoresRemovals(true)
	r.run(30 * time.Minute)
	maxEntry := int64(100_000_000 + 4096)
	if got := evictedBytes(r.w); got > 3*GB+maxEntry || got < 2*GB {
		t.Fatalf("evicted %s at 12 GB free with no disk coming back, want about 3 GB", gbf(got))
	}
	if !r.logHas("no effect: evicted") || !r.logHas("free disk +0.00GB") {
		t.Errorf("no no-effect line in the log:\n%s", tail(r.log.String(), 1500))
	}
	r.setFree(6 * GB)
	r.run(time.Hour)
	if got := evictedBytes(r.w); got > 12*GB+maxEntry {
		t.Fatalf("evicted %s in total, more than the 12 GB deficit at 6 GB free plus one entry", gbf(got))
	}
	r.noViolations()
	t.Logf("evicted %s of %s; cache now %s", gbf(evictedBytes(r.w)), gbf(30*GB), gbf(r.w.CacheBytes()))
}

// Outputs queued for their settle are no reason to tick again at once: at
// emergency free disk with nothing else left, the daemon waits for them on
// its normal tick instead of polling every bucket every few milliseconds.
func TestQueuedOutputsDontSpin(t *testing.T) {
	r := newRig(t, 74, nil)
	r.warm()
	as := r.place(10, cachesim.Archive, 100_000_000, 6*time.Hour)
	r.setFree(5 * GB)
	ticks := 0
	r.w.Run(r.w.Now()+time.Minute, func() time.Duration { ticks++; return r.c.tick() })
	if gone := outputsGone(r.w, as); gone != len(as) {
		t.Fatalf("%d of %d outputs removed at 5 GB free", gone, len(as))
	}
	if limit := int(time.Minute/r.cfg.Tick) + 20; ticks > limit {
		t.Fatalf("%d ticks in a minute of emergency with only queued outputs, want at most %d", ticks, limit)
	}
	r.noViolations()
}

// D4: the episode cap counts only eviction below the budget. A cache 10 GB
// over budget at 14 GB free (removals give no disk back) plans all 10 GB in
// observe mode, and owner mode gets to the budget and then serves the 1 GB
// deficit below it, no more.
func TestD4BudgetEvictionNotCapped(t *testing.T) {
	r := newRig(t, 72, nil)
	r.run(time.Minute)
	r.place(400, cachesim.Archive, 100_000_000, 5*time.Hour)
	r.w.SetCapacity(r.w.CacheBytes() + 14*GB)
	r.w.FreeIgnoresRemovals(true)
	r.run(time.Minute)
	budget, entry := r.cfg.Limits.Budget, int64(100_000_000+2*4096)
	over := r.w.CacheBytes() - budget
	if w := r.state().WouldEvictBytes; w == nil || *w < over || *w > over+entry {
		t.Fatalf("observe plans %s, want the %s over the budget", gbf(deref(w)), gbf(over))
	}
	r.w.SetMode("owner", true)
	r.run(time.Hour)
	got := r.w.CacheBytes()
	if got > budget-GB+entry {
		t.Fatalf("cache %s after an hour at 14 GB free: the 1 GB deficit below the %s budget was not served", gbf(got), gbf(budget))
	}
	if got < budget-GB-entry {
		t.Fatalf("cache %s: evicted more than the 1 GB deficit below the budget plus one entry", gbf(got))
	}
	r.noViolations()
}

// S20: free disk swinging around 15 GB and around 8 GB for six hours.
// Hysteresis keeps the total within the largest deficit plus one entry, and
// at 8 GB nothing used within 2 h goes while older entries exist.
func TestS20Oscillation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		low, top int64
	}{{"around-15GB", 14_500_000_000, 15_500_000_000}, {"around-8GB", 7_900_000_000, 8_100_000_000}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newRig(t, 80, nil)
			r.w.SetMode("owner", true)
			r.run(time.Minute)
			r.place(200, cachesim.Archive, 100_000_000, 3*time.Hour)
			r.place(99, cachesim.Archive, 100_000_000, 20*time.Minute)
			r.w.SetExternal(0)
			ext0 := r.w.FreeNow() - tc.top
			r.w.SetExternal(ext0)
			high := true
			var swing func()
			swing = func() {
				high = !high
				if high {
					r.w.SetExternal(ext0)
				} else {
					r.w.SetExternal(ext0 + tc.top - tc.low)
				}
				r.w.After(time.Minute, swing)
			}
			r.w.After(time.Minute, swing)
			r.run(6 * time.Hour)
			r.noViolations()
			deficit := r.cfg.Limits.DiskFloor - tc.low
			if got := evictedBytes(r.w); got > deficit+100_004_096 {
				t.Errorf("evicted %s over six hours, largest deficit %s", gbf(got), gbf(deficit))
			}
			// 20 GB idle > 2 h covers every deficit here.
			for _, e := range r.ev {
				if e.Age <= r.cfg.Limits.Window {
					t.Fatalf("%s idle %s removed while entries idle > 2 h existed", e.Rel, e.Age)
				}
			}
			t.Logf("evicted %s, %d removals", gbf(evictedBytes(r.w)), len(r.ev))
		})
	}
}

// S21: over budget by 1 GB, everything idle beyond Go's own trim age goes
// before a 1 GB archive idle 2.5 h or a small entry idle 6 h.
func TestS21Ordering(t *testing.T) {
	r := newRig(t, 90, nil)
	r.warm()
	archive := r.place(1, cachesim.Archive, 1_000_000_000, 150*time.Minute)[0]
	week := r.place(1000, cachesim.Archive, 1_000_000, 6*24*time.Hour)
	small := r.place(1, cachesim.Archive, 500_000, 6*time.Hour)[0]
	r.cfg.Limits.Budget = r.w.CacheBytes() - 1*GB
	r.c.cfg.Limits.Budget = r.cfg.Limits.Budget
	r.run(5 * time.Minute)
	r.noViolations()
	for _, a := range []*cachesim.Action{archive, small} {
		if _, out := a.Rels(); !r.w.Exists(out) {
			t.Errorf("%s (%d bytes) evicted while week-old entries were left", out, a.Size)
		}
	}
	if n := outputsGone(r.w, week); n < 980 {
		t.Errorf("only %d of 1000 week-old entries evicted", n)
	}
}

// D4 (amended), skeptic finding 1: removals free no disk (FreeIgnoresRemovals)
// while free disk swings 5.8 <-> 7.2 GB every 2 minutes, across the emergency
// line. 299 x 100 MB idle 5 h sit under the budget. Eviction stays within the
// largest deficit (15 - 5.8 = 9.2 GB) plus one entry, however long it swings
// and wherever a swing falls relative to the chunks.
func TestD4SwingWithNoEffect(t *testing.T) {
	for phase := time.Second; phase <= 2*time.Minute; phase += 7 * time.Second {
		t.Run(phase.String(), func(t *testing.T) {
			t.Parallel()
			swingWithNoEffect(t, phase)
		})
	}
}

func swingWithNoEffect(t *testing.T, phase time.Duration) {
	r := newRig(t, 73, nil)
	r.w.SetMode("owner", true)
	r.run(time.Minute)
	r.place(299, cachesim.Archive, 100_000_000, 5*time.Hour)
	r.w.FreeIgnoresRemovals(true)
	r.w.SetExternal(0)
	ext0 := r.w.FreeNow() - 7_200_000_000
	r.w.SetExternal(ext0)
	high := true
	var swing func()
	swing = func() {
		high = !high
		if high {
			r.w.SetExternal(ext0)
		} else {
			r.w.SetExternal(ext0 + 1_400_000_000)
		}
		r.w.After(2*time.Minute, swing)
	}
	r.w.After(phase, swing)
	entry := int64(100_000_000 + 2*4096)
	r.run(30 * time.Minute)
	if got := evictedBytes(r.w); got > 9_200_000_000+entry {
		t.Fatalf("evicted %s in 30 minutes with no disk coming back; the largest deficit is 9.2 GB\n%s", gbf(got), tail(r.log.String(), 3000))
	}
	r.run(90 * time.Minute)
	got := evictedBytes(r.w)
	if got > 9_200_000_000+entry {
		t.Fatalf("evicted %s in 2 hours with no disk coming back; the largest deficit is 9.2 GB", gbf(got))
	}
	if got < 5*GB {
		t.Errorf("evicted only %s: the deficit was never served", gbf(got))
	}
	r.noViolations()
}

// D4 (amended), skeptic finding 2: removals do free disk, and something
// outside the cache (Docker, simulators, $TMPDIR) slides free disk from 14.9
// to 8.3 GB over 3 h. 20 GB idle 8 h: the daemon keeps free disk near 15 GB
// from entries outside the window. Then another 10 GB goes outside the cache
// over 3 h: the cache stops at the 15 GB floor, since free disk stays above
// the hard floor.
func TestD4ExternalGrowthFollowed(t *testing.T) {
	r := newRig(t, 74, nil)
	r.w.SetMode("owner", true)
	r.run(time.Minute)
	r.place(200, cachesim.Archive, 100_000_000, 8*time.Hour)
	r.place(99, cachesim.Archive, 100_000_000, 20*time.Minute)
	r.w.SetExternal(0)
	ext := r.w.FreeNow() - 14_900_000_000
	r.w.SetExternal(ext)
	start := r.w.Now()
	eat := func(total int64, over time.Duration) {
		steps := int(over / (10 * time.Second))
		for i := 1; i <= steps; i++ {
			r.w.At(r.w.Now()+time.Duration(i)*10*time.Second, func() {
				ext += total / int64(steps)
				r.w.SetExternal(ext)
			})
		}
	}
	eat(6_600_000_000, 3*time.Hour)
	low := minFree(r.w, start+3*time.Hour)
	r.run(3 * time.Hour)
	entry := int64(100_000_000 + 2*4096)
	if f := r.w.FreeNow(); f < 15*GB-entry-200_000_000 {
		t.Fatalf("free disk %s after 6.6 GB went outside the cache: not kept near 15 GB (evicted %s, reasons %q)\n%s",
			gbf(f), gbf(evictedBytes(r.w)), r.state().Extra.Reasons, tail(r.log.String(), 3000))
	}
	if *low < 14_500_000_000 {
		t.Errorf("free disk fell to %s while 20 GB idle 8 h was there", gbf(*low))
	}
	for _, e := range r.ev {
		if e.Age <= r.cfg.Limits.Window {
			t.Fatalf("%s idle %s removed inside the 2 h window", e.Rel, e.Age)
		}
	}
	eat(10*GB, 3*time.Hour)
	r.run(3*time.Hour + time.Minute)
	if c := r.w.CacheBytes(); c < r.cfg.Limits.CacheFloor-entry {
		t.Fatalf("cache %s below the 15 GB floor above the hard tier (free %s)", gbf(c), gbf(r.w.FreeNow()))
	}
	if c := r.w.CacheBytes(); c > r.cfg.Limits.CacheFloor+entry {
		t.Errorf("cache %s: not shrunk to the 15 GB floor while free disk was %s", gbf(c), gbf(r.w.FreeNow()))
	}
	r.noViolations()
	t.Logf("lowest free %s in the first 3 h, evicted %s, cache now %s, free %s", gbf(*low), gbf(evictedBytes(r.w)), gbf(r.w.CacheBytes()), gbf(r.w.FreeNow()))
}
