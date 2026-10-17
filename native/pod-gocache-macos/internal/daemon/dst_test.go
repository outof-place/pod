package daemon

import (
	"fmt"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

var dstTotals struct {
	seeds, removals, failures, relaxed, races, concurrentRefs atomic.Int64
	removedBytes, d4Episodes, d4Excess, snapshots             atomic.Int64
}

// TestDSTRandom drives the daemon through random days: dozens of go commands
// with mixed lifetimes, go list -export with readers after it, killed puts,
// shared outputs, executables, free disk wandering through every tier, sleeps
// and clock steps, mode flips, crashes and restarts, stray and future-dated
// files. The world checks every removal against the rules (window in awake
// time, the process window, start grace, references, observe mode, allowed
// names); afterwards every build must have found what it looked up, and with
// the machine idle the cache must converge to the budget.
//
// POD_GOCACHE_DST_SEEDS and POD_GOCACHE_DST_HOURS scale it up.
func TestDSTRandom(t *testing.T) {
	seeds := envInt("POD_GOCACHE_DST_SEEDS", 6)
	hours := envInt("POD_GOCACHE_DST_HOURS", 3)
	first := envInt("POD_GOCACHE_DST_FIRST", 1)
	t.Run("all", func(t *testing.T) {
		for s := first; s < first+seeds; s++ {
			t.Run(fmt.Sprint("seed", s), func(t *testing.T) {
				t.Parallel()
				randomDay(t, int64(s), time.Duration(hours)*time.Hour)
			})
		}
	})
	t.Logf("DST: %d seeds x %dh active + idle tail: %d removals (%s), %d build failures (%d in relaxed tiers, %d put races), %d outputs removed while a same-tick -a referenced them",
		dstTotals.seeds.Load(), hours, dstTotals.removals.Load(), gbf(dstTotals.removedBytes.Load()),
		dstTotals.failures.Load(), dstTotals.relaxed.Load(), dstTotals.races.Load(), dstTotals.concurrentRefs.Load())
	t.Logf("D4: %d low-disk episodes checked (%d snapshot periods where removals freed nothing); most evicted for disk beyond an episode's largest deficit: %s",
		dstTotals.d4Episodes.Load(), dstTotals.snapshots.Load(), gbf(dstTotals.d4Excess.Load()))
}

func randomDay(t *testing.T, seed int64, active time.Duration) {
	r := newRig(t, seed, nil)
	w := r.w
	rng := w.Rand()
	wl := w.NewWorkload(3000)
	w.Populate(wl, 1500, 7*24*time.Hour)
	for i := 0; i < 20; i++ {
		w.AddTemp(rng.Intn(256), int32(50000+rng.Intn(1000)), int64(rng.Intn(50_000_000)), time.Duration(rng.Int63n(int64(5*time.Hour))))
	}
	for i := 0; i < 5; i++ {
		a := wl.Actions[rng.Intn(len(wl.Actions))]
		w.Place(a, -time.Duration(rng.Int63n(int64(80*365*24*time.Hour)))) // dated decades ahead
	}
	cache := w.CacheBytes()
	capacity := 200 * GB
	w.SetCapacity(capacity)
	setFree := func(free int64) {
		w.SetExternal(0)
		w.SetExternal(max(0, w.FreeNow()-free))
	}
	snapshots := 0
	setFree(40 * GB)
	t.Logf("seed %d: cache %s, %d actions", seed, gbf(cache), len(wl.Actions))

	end := w.Now() + active
	w.Start(wl, end)
	restart := false
	// Free disk wanders through the tiers.
	var wander func()
	wander = func() {
		if w.Now() >= end {
			return
		}
		levels := []int64{40 * GB, 25 * GB, 16 * GB, 14 * GB, 12 * GB, 9 * GB, 8*GB - 1, 7 * GB, 5 * GB}
		setFree(levels[rng.Intn(len(levels))])
		w.After(time.Duration(5+rng.Intn(30))*time.Minute, wander)
	}
	w.After(time.Duration(rng.Intn(20))*time.Minute, wander)
	// Owner after a while, with occasional flips and a broken mode file.
	w.After(time.Duration(rng.Intn(30))*time.Minute, func() { w.SetMode("owner", true) })
	var flip func()
	flip = func() {
		if w.Now() >= end {
			return
		}
		switch rng.Intn(6) {
		case 0:
			w.SetMode("observe", true)
			w.After(time.Duration(rng.Intn(20))*time.Minute, func() { w.SetMode("owner", true) })
		case 1:
			w.SetMode("observe", false)
			w.After(time.Duration(rng.Intn(5))*time.Second, func() { w.SetMode("owner", true) })
		}
		w.After(time.Duration(10+rng.Intn(50))*time.Minute, flip)
	}
	w.After(time.Hour, flip)
	// Sleeps, clock steps and crashes.
	var trouble func()
	trouble = func() {
		if w.Now() >= end {
			return
		}
		switch rng.Intn(6) {
		case 0:
			w.Sleep(time.Duration(1+rng.Intn(10)) * time.Hour)
		case 1:
			w.StepClock(time.Duration(rng.Intn(7)-3) * time.Hour)
		case 2:
			restart = true
		case 3:
			// A local snapshot: removals free nothing for a while.
			snapshots++
			w.FreeIgnoresRemovals(true)
			w.After(time.Duration(20+rng.Intn(40))*time.Minute, func() { w.FreeIgnoresRemovals(false) })
		}
		w.After(time.Duration(20+rng.Intn(60))*time.Minute, trouble)
	}
	w.After(time.Duration(rng.Intn(60))*time.Minute, trouble)

	tick := func() time.Duration {
		if restart {
			restart = false
			r.start()
		}
		return r.c.tick()
	}
	w.Run(end, tick)
	// Idle tail: go quiet, plenty of disk, longer than every window.
	setFree(60 * GB)
	w.Run(w.Now()+10*time.Hour, tick)

	r.noViolations()
	r.noUnexplainedFailures()
	if gap := r.maxHeartbeatGap(0); gap > r.cfg.HeartbeatEvery+r.cfg.FullBatchTime+2*r.cfg.Tick {
		t.Errorf("owner.json heartbeat gap %s", gap)
	}
	st := r.state()
	size := w.CacheBytes()
	stuck := st.Extra.StuckBytes + st.Extra.FutureBytes
	if size > r.cfg.Limits.Budget+stuck+300_000_000 {
		t.Errorf("idle cache %s did not converge to budget %s (stuck/future %s); reasons %v", gbf(size), gbf(r.cfg.Limits.Budget), gbf(stuck), st.Extra.Reasons)
	}
	if w.Live() != 0 {
		t.Errorf("%d processes still alive after the idle tail", w.Live())
	}
	var relaxed, races int64
	for _, f := range w.Failures {
		if f.Class == "concurrent-put" {
			races++
		} else {
			relaxed++
		}
	}
	var bytes int64
	for _, rm := range w.Removals {
		bytes += rm.Bytes
	}
	dstTotals.seeds.Add(1)
	dstTotals.removals.Add(int64(len(w.Removals)))
	dstTotals.removedBytes.Add(bytes)
	dstTotals.failures.Add(int64(len(w.Failures)))
	dstTotals.relaxed.Add(relaxed)
	dstTotals.races.Add(races)
	dstTotals.concurrentRefs.Add(int64(w.ConcurrentRefs))
	dstTotals.d4Episodes.Add(int64(w.D4Episodes))
	dstTotals.snapshots.Add(int64(snapshots))
	for {
		cur := dstTotals.d4Excess.Load()
		if w.D4Excess <= cur || dstTotals.d4Excess.CompareAndSwap(cur, w.D4Excess) {
			break
		}
	}
	t.Logf("seed %d: %d removals (%s), final cache %s, failures %d (relaxed %d, races %d), heartbeat gap %s",
		seed, len(w.Removals), gbf(bytes), gbf(size), len(w.Failures), relaxed, races, r.maxHeartbeatGap(0))
}
