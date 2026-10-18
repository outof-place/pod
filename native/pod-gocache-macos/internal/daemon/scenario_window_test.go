package daemon

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
)

// tinyBudget makes everything outside the window due for eviction.
func tinyBudget(c *Config) { c.Limits.Budget = 1 }

// s1Build runs one go build of the given life that looks up deps whose
// mtimes are 59 minutes old (Go's hourly refresh skips them) and reads them
// again just before it exits, the way link reads archives.
func s1Build(t *testing.T, life time.Duration, procs bool) *rig {
	r := newRig(t, int64(life/time.Minute), func(c *Config) {
		tinyBudget(c)
		if !procs {
			c.Procs = noProcs{}
		}
	})
	r.warm()
	deps := r.place(200, cachesim.Archive, 5_000_000, 59*time.Minute)
	junk := r.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Child: "compile", Life: life})
	for _, a := range deps {
		r.w.Lookup(p, a)
	}
	r.run(life + 40*time.Minute)
	r.noViolations()
	if gone := outputsGone(r.w, junk); gone != len(junk) {
		t.Fatalf("only %d of %d week-old entries evicted: the run proves nothing", gone, len(junk))
	}
	return r
}

// S1: no file a live go process looked up is deleted before it exits, for
// lives past the window minus Go's one-hour refresh lag.
func TestS1LongBuildKeepsWhatItLookedUp(t *testing.T) {
	for _, m := range []int{30, 61, 90, 180, 360} {
		t.Run(fmt.Sprint(m, "min"), func(t *testing.T) {
			t.Parallel()
			r := s1Build(t, time.Duration(m)*time.Minute, true)
			if len(r.w.Failures) > 0 {
				t.Fatalf("%d lookups failed, first %+v", len(r.w.Failures), r.w.Failures[0])
			}
			if len(r.w.Removals) == 0 {
				t.Fatal("nothing removed")
			}
		})
	}
	// Without the process term the long builds lose their inputs: the test
	// above is not passing by accident.
	t.Run("sabotage-no-process-term", func(t *testing.T) {
		t.Parallel()
		for _, m := range []int{180, 360} {
			if r := s1Build(t, time.Duration(m)*time.Minute, false); len(r.w.Failures) == 0 {
				t.Errorf("%d min build without the process term lost nothing", m)
			}
		}
	})
}

// S1 limits: a go run serving for days and a gopls open for days count as 30
// minutes old, a hung go test counts as at most 6 h old (window 7 h 5 min),
// and the hard floor ignores processes altogether.
func TestS1WindowCaps(t *testing.T) {
	cases := []struct {
		name      string
		comm      string
		child     string
		age       time.Duration
		free      int64
		window    time.Duration
		goneAge   time.Duration // entries this idle are evicted
		keptAge   time.Duration // entries this idle stay
		keptCount int
	}{
		{"go-run-3-days", "go", "server", 72 * time.Hour, 0, 2 * time.Hour, 3 * time.Hour, 90 * time.Minute, 50},
		{"gopls-3-days", "gopls", "", 72 * time.Hour, 0, 2 * time.Hour, 3 * time.Hour, 90 * time.Minute, 50},
		{"go-test-hung-2-days", "go", "pkg.test", 48 * time.Hour, 0, 7*time.Hour + 5*time.Minute, 8 * time.Hour, 3 * time.Hour, 50},
		{"hard-floor-ignores-processes", "go", "pkg.test", 48 * time.Hour, 7_500_000_000, 7*time.Hour + 5*time.Minute, 45 * time.Minute, 10 * time.Minute, 50},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newRig(t, 3, tinyBudget)
			r.warm()
			p := r.w.Spawn(cachesim.ProcSpec{Comm: tc.comm, Kind: "gorun", Child: tc.child, Life: 100 * time.Hour})
			p.Start -= int64(tc.age)
			gone := r.place(50, cachesim.Archive, 20_000_000, tc.goneAge)
			kept := r.place(tc.keptCount, cachesim.Archive, 1_000_000, tc.keptAge)
			if tc.free > 0 {
				// Enough above-window bytes elsewhere would end the hard tier
				// before it reaches the young entries, so keep it short.
				r.w.SetCapacity(r.w.CacheBytes() + tc.free)
			}
			r.run(20 * time.Minute)
			r.noViolations()
			if got := time.Duration(r.state().Extra.WindowSeconds) * time.Second; got != tc.window {
				t.Errorf("window %s, want %s (reason %q)", got, tc.window, r.state().Extra.WindowReason)
			}
			if n := outputsGone(r.w, gone); n != len(gone) {
				t.Errorf("%d of %d entries idle %s evicted", n, len(gone), tc.goneAge)
			}
			if n := outputsGone(r.w, kept); n != 0 {
				t.Errorf("%d entries idle %s evicted", n, tc.keptAge)
			}
		})
	}
}

// S2: builds revive pre-aged entries while the daemon evicts at 6 GB free.
// The world flags any removal whose recency at unlink time is inside the
// window; every build lives shorter than the emergency window, so none may
// lose a file; and a good share of the entries must go while builds run.
func TestS2RevivalRace(t *testing.T) {
	r := newRig(t, 2, nil)
	r.warm()
	r.w.OpCost = 200 * time.Microsecond // a slow disk widens the scan-to-unlink gap
	aged := r.place(6000, cachesim.Archive, 4_000_000, 3*time.Hour)
	r.w.SetCapacity(r.w.CacheBytes() + 6*GB)
	rng := r.w.Rand()
	end := r.w.Now() + 40*time.Minute
	for loop := 0; loop < 10; loop++ {
		var round func()
		round = func() {
			if r.w.Now() >= end {
				return
			}
			kind := []string{"build", "vet", "test", "list"}[rng.Intn(4)]
			life := time.Duration(30+rng.Intn(240)) * time.Second
			p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: kind, Life: life, Export: kind == "list"})
			for i := 0; i < 20; i++ {
				a := aged[rng.Intn(len(aged))]
				r.w.After(time.Duration(rng.Int63n(int64(life/2))), func() { r.w.Lookup(p, a) })
			}
			r.w.After(life+time.Second, round)
		}
		r.w.After(time.Duration(loop)*time.Second, round)
	}
	r.run(90 * time.Minute)
	r.noViolations()
	races := 0
	for _, f := range r.w.Failures {
		if f.Class != "concurrent-put" {
			t.Fatalf("a build lost a file: %+v", f)
		}
		races++
	}
	outs := map[string]bool{}
	for _, a := range aged {
		_, out := a.Rels()
		outs[out] = true
	}
	whileLive := 0
	for _, rm := range r.w.Removals {
		if rm.Live > 0 && outs[rm.Rel] {
			whileLive++
		}
	}
	if whileLive*10 < len(aged)*3 {
		t.Fatalf("only %d of %d pre-aged entries evicted while builds ran", whileLive, len(aged))
	}
	t.Logf("removals %d, pre-aged outputs evicted while builds ran %d of %d, put races %d, free now %s",
		len(r.w.Removals), whileLive, len(aged), races, gbf(r.w.FreeNow()))
}

// At the hard floor (processes ignored) a build keeps reading outputs it
// looked up 50 minutes after their put. Their -a go; the queued outputs were
// armed, so the reads show as use and the outputs stay.
func TestQueuedOutputReadDuringSettleStays(t *testing.T) {
	r := newRig(t, 91, nil)
	r.warm()
	held := r.place(40, cachesim.Archive, 20_000_000, 50*time.Minute)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 3 * time.Hour})
	for _, a := range held {
		r.w.Lookup(p, a)
	}
	r.run(time.Second)
	now := r.w.Now()
	for _, a := range held {
		_, out := a.Rels()
		for at := time.Second; at <= 20*time.Minute; at += time.Second {
			r.w.UseAt(p, out, now+at)
		}
	}
	r.setFree(7_500_000_000)
	r.run(20 * time.Minute)
	r.noViolations()
	actions := 0
	for _, a := range held {
		if act, _ := a.Rels(); !r.w.Exists(act) {
			actions++
		}
	}
	if actions < len(held)/2 {
		t.Fatalf("only %d of %d -a removed: no output was ever queued", actions, len(held))
	}
	if n := outputsGone(r.w, held); n > 0 || len(r.w.Failures) > 0 {
		t.Fatalf("%d outputs a running build was reading removed, %d failed reads", n, len(r.w.Failures))
	}
}

// S3: after a sleep or a forward clock step an entry used 30 minutes before
// counts its awake age only; heartbeat and trim.txt are rewritten in the
// first cycle; a restart right after the wake keeps the credit.
func TestS3SleepAndClockSteps(t *testing.T) {
	// The restart case runs at 12 GB free: above 15 GB the new process's
	// start grace would protect the entries by itself.
	cases := []struct {
		name    string
		jump    func(w *cachesim.World)
		restart bool
	}{
		{"sleep-8h", func(w *cachesim.World) { w.Sleep(8 * time.Hour) }, false},
		{"clock-plus-3h", func(w *cachesim.World) { w.StepClock(3 * time.Hour) }, false},
		{"sleep-8h-then-restart-low-disk", func(w *cachesim.World) { w.Sleep(8 * time.Hour) }, true},
		{"sleep-30h", func(w *cachesim.World) { w.Sleep(30 * time.Hour) }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			r := newRig(t, 4, tinyBudget)
			r.warm()
			used := r.place(100, cachesim.Archive, 2_000_000, 30*time.Minute)
			if tc.restart {
				r.w.SetCapacity(r.w.CacheBytes() + 12*GB)
			}
			r.run(time.Minute)
			tc.jump(r.w)
			if tc.restart {
				r.start()
			}
			wake, wakeWall := r.w.Now(), r.w.Wall().Unix()
			beats, trims := len(r.w.Owners), len(r.w.TrimWrites)
			r.run(5 * time.Second)
			if len(r.w.TrimWrites) == trims || r.w.TrimWrites[trims]-wake > r.cfg.Tick {
				t.Error("trim.txt not rewritten in the first cycle after the jump")
			}
			if len(r.w.Owners) == beats {
				t.Fatal("no heartbeat after the jump")
			}
			if b := r.w.Owners[beats]; b.Mono-wake > r.cfg.Tick || b.HeartbeatAt < wakeWall {
				t.Errorf("first heartbeat after the jump at +%s says %d, wall at wake %d", b.Mono-wake, b.HeartbeatAt, wakeWall)
			}
			r.run(80 * time.Minute)
			if n := outputsGone(r.w, used); n > 0 {
				t.Fatalf("%d entries with 1h51m awake age evicted after the jump", n)
			}
			r.run(15 * time.Minute)
			if n := outputsGone(r.w, used); n != len(used) {
				t.Errorf("%d of %d entries evicted once the window passed in awake time", n, len(used))
			}
			r.noViolations()
			if !r.logHas("clock-jump") && !tc.restart {
				t.Error("jump not logged")
			}
		})
	}
}

// S3: the clock stepped back 3 h leaves fresh entries dated in the future;
// they stay protected, the daemon keeps running and trim.txt is rewritten
// with the new time within one cycle.
func TestS3ClockBack(t *testing.T) {
	r := newRig(t, 5, tinyBudget)
	r.warm()
	fresh := r.place(100, cachesim.Archive, 2_000_000, 0)
	r.w.StepClock(-3 * time.Hour)
	trims := len(r.w.TrimWrites)
	r.run(5 * time.Second)
	if len(r.w.TrimWrites) == trims || r.w.TrimValue() > r.w.Wall().Unix() {
		t.Errorf("trim.txt not rewritten to the new time: %d writes, value %d, now %d", len(r.w.TrimWrites)-trims, r.w.TrimValue(), r.w.Wall().Unix())
	}
	r.run(4 * time.Hour)
	if n := outputsGone(r.w, fresh); n > 0 {
		t.Fatalf("%d entries dated up to 3 h ahead evicted", n)
	}
	r.noViolations()
}

// S10: export data read by a non-go tool long after `go list -export` exited.
// Lookups 59 minutes old get no refresh; the readers come at +5, +30 and +45
// minutes. After a short go list the window keeps their files; after a
// 30 minute one only the exited go list, still counted for 45 minutes, does.
func TestS10ExportReadAfterExit(t *testing.T) {
	for _, life := range []time.Duration{3 * time.Minute, 30 * time.Minute} {
		t.Run(life.String(), func(t *testing.T) {
			t.Parallel()
			r := newRig(t, 6, tinyBudget)
			r.warm()
			deps := r.place(300, cachesim.Archive, 3_000_000, 59*time.Minute)
			r.place(300, cachesim.Archive, 3_000_000, 50*time.Hour)
			p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "list", Life: life, Export: true})
			for _, a := range deps {
				r.w.Lookup(p, a)
			}
			r.run(2 * time.Hour)
			r.noViolations()
			if len(r.w.Failures) > 0 {
				t.Fatalf("%d export reads failed, first %+v", len(r.w.Failures), r.w.Failures[0])
			}
			if len(r.w.Removals) < 300 {
				t.Fatalf("only %d removals: the budget never pressed", len(r.w.Removals))
			}
		})
	}
}

// D2: the start grace holds while free disk >= 15 GB and not below it.
func TestD2StartGrace(t *testing.T) {
	t.Run("plenty-of-disk", func(t *testing.T) {
		r := newRig(t, 7, tinyBudget)
		r.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
		r.w.SetMode("owner", true)
		r.run(10 * time.Minute)
		if r.state().Extra.GraceUntil == 0 {
			t.Error("status shows no grace end")
		}
		r.run(time.Hour + 45*time.Minute)
		if len(r.w.Removals) > 0 {
			t.Fatalf("%d removals inside the start grace", len(r.w.Removals))
		}
		r.run(10 * time.Minute)
		if len(r.w.Removals) == 0 {
			t.Fatal("nothing removed after the grace")
		}
		r.noViolations()
	})
	t.Run("low-disk", func(t *testing.T) {
		r := newRig(t, 8, tinyBudget)
		r.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
		r.w.SetCapacity(r.w.CacheBytes() + 12*GB)
		r.w.SetMode("owner", true)
		r.run(2 * time.Minute)
		if len(r.w.Removals) == 0 {
			t.Fatal("no removals in the first two minutes below 15 GB free")
		}
		if r.state().Extra.GraceUntil != 0 {
			t.Error("status claims a grace below 15 GB free")
		}
		r.noViolations()
	})
}

// Finding 5: a go build running 6 h widens W to 7 h 5 min. At 7.5 GB free the
// hard tier needs 1.5 GB: the 30 x 100 MB idle 10 to 20 h (outside W) go, and
// the 1.5 GB entry idle 6.5 h (inside W) stays, though the relaxed 30 minute
// window would allow it.
func TestWindowOverSixHoursIsABucketBound(t *testing.T) {
	r := newRig(t, 75, floors8and6)
	r.w.SetMode("owner", true)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Child: "compile", Life: 100 * time.Hour})
	p.Start -= int64(6 * time.Hour)
	inside := r.place(1, cachesim.Archive, 1_500_000_000, 6*time.Hour+30*time.Minute)[0]
	rng := r.w.Rand()
	old := make([]*cachesim.Action, 0, 30)
	for i := 0; i < 30; i++ {
		old = append(old, r.place(1, cachesim.Archive, 100_000_000, time.Duration(600+rng.Intn(600))*time.Minute)...)
	}
	r.w.SetCapacity(r.w.CacheBytes() + 7_500_000_000)
	r.run(5 * time.Minute)
	r.noViolations()
	if got := time.Duration(r.state().Extra.WindowSeconds) * time.Second; got != 7*time.Hour+5*time.Minute {
		t.Fatalf("window %s, want 7h5m (%q)", got, r.state().Extra.WindowReason)
	}
	if _, out := inside.Rels(); !r.w.Exists(out) {
		t.Error("the 1.5 GB entry inside W was evicted while entries outside W covered the hard tier's need")
	}
	if n := outputsGone(r.w, old); n < 15 {
		t.Errorf("only %d of the entries idle 10 to 20 h evicted; the hard tier needed 1.5 GB", n)
	}
}

// failingDisk is a free-disk source whose statfs always fails; the world
// still knows the true free disk for its own checks.
type failingDisk struct{ w *cachesim.World }

func (d failingDisk) Free() (int64, error) {
	d.w.Free()
	return 0, errors.New("statfs: input/output error")
}

// Finding 11: with free disk unknown the start grace holds (no deletions for
// the first 2 h), and afterwards the daemon keeps to the budget.
func TestGraceWithUnknownFreeDisk(t *testing.T) {
	r := newRig(t, 76, tinyBudget)
	r.cfg.Disk = failingDisk{r.w}
	r.start()
	r.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
	r.w.SetMode("owner", true)
	r.run(time.Hour + 50*time.Minute)
	if len(r.w.Removals) > 0 {
		t.Fatalf("%d removals inside the start grace with free disk unknown", len(r.w.Removals))
	}
	if !reasonsHave(r, "start grace") || !reasonsHave(r, "free disk unknown") {
		t.Errorf("reasons %q", r.state().Extra.Reasons)
	}
	r.run(15 * time.Minute)
	if len(r.w.Removals) == 0 {
		t.Fatal("nothing removed after the grace")
	}
	r.noViolations()
}

// Finding 6: the daemon stopped 70 minutes into a boot, the Mac was off for 2
// days, and the daemon starts 3 h into the new boot. Awake time grew, but
// kern.boottime changed: no sleep credit. An entry last used a minute before
// the stop is 2 days old and goes. With the same boot (a 2-day sleep while no
// daemon ran) it is credited and stays.
func TestRebootGivesNoSleepCredit(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sameBoot bool
	}{{"reboot", false}, {"sleep-while-down", true}} {
		t.Run(tc.name, func(t *testing.T) {
			r1 := newRig(t, 77, tinyBudget)
			r1.run(10 * time.Minute)
			prev := r1.state()
			stopWall := time.Unix(0, prev.Extra.LastWallNs)

			r2 := buildRig(t, 78, stopWall.Add(48*time.Hour+time.Hour), tinyBudget)
			if tc.sameBoot {
				r2.w.BootUs = r1.w.BootUs
			}
			r2.sink.Restore(prev)
			r2.w.Run(r2.w.Now()+2*time.Hour, func() time.Duration { return time.Hour }) // 3 h into the boot
			r2.w.SetCapacity(r2.w.CacheBytes() + 12*GB)                                 // below 15 GB: no start grace
			used := r2.place(1, cachesim.Archive, 5_000_000, r2.w.Wall().Sub(stopWall.Add(-time.Minute)))[0]
			r2.w.SetMode("owner", true)
			r2.start()
			r2.run(time.Minute)
			_, out := used.Rels()
			if tc.sameBoot == !r2.w.Exists(out) {
				t.Fatalf("entry used a minute before the stop: exists %v; log:\n%s", r2.w.Exists(out), tail(r2.log.String(), 1500))
			}
			if !tc.sameBoot && !r2.logHas("reboot since the last run") {
				t.Errorf("no reboot line in the log:\n%s", tail(r2.log.String(), 1500))
			}
		})
	}
}

// S12b: a throttled disk (every file system call takes 50 ms, about what one
// lstat cost under load on this Mac) and a cache of 20k files. Each tick's
// scan stops after its time budget and resumes next tick, and owner.json is
// written on time from inside long scans and batches, never at background
// priority: the heartbeat gap stays under 60 s.
func TestS12bHeartbeatUnderThrottledDisk(t *testing.T) {
	r := newRig(t, 79, tinyBudget)
	r.w.OpCost = 50 * time.Millisecond
	r.place(10_000, cachesim.Archive, 1_000_000, 3*time.Hour)
	r.w.SetCapacity(r.w.CacheBytes() + 12*GB) // below 15 GB: evicting, throttled
	r.w.SetMode("owner", true)
	r.start()
	start := r.w.Now()
	var longest time.Duration
	r.w.Run(start+time.Hour, func() time.Duration {
		s := r.w.Now()
		d := r.c.tick()
		longest = max(longest, r.w.Now()-s)
		return d
	})
	r.noViolations()
	if gap := r.maxHeartbeatGap(start); gap > time.Minute {
		t.Errorf("owner.json heartbeat gap %s under a throttled disk", gap)
	}
	if longest > 20*time.Second {
		t.Errorf("a tick took %s; scans must stop after their budget", longest)
	}
	for _, b := range r.w.Owners {
		if b.Background {
			t.Fatalf("owner.json written at background priority at t=%s", b.Mono-start)
		}
	}
	// At 50 ms a call a poll of 256 buckets outlasts a batch, so outputs wait
	// for a calmer disk; the -a files go.
	if st := r.state(); st.Extra.Phase != "ready" || len(r.w.Removals) == 0 {
		t.Errorf("phase %q, %d removals: the run did not get through indexing to eviction", st.Extra.Phase, len(r.w.Removals))
	}
	t.Logf("longest tick %s, heartbeat gap %s, %d removals", longest, r.maxHeartbeatGap(start), len(r.w.Removals))
}

// Phase A follow-up: after a reboot since the last state.json no go process
// can hold entries the daemon has not seen used, so the start grace is
// skipped and an over-budget cache shrinks at once (18.10: it grew 32 -> 43
// GB in 70 minutes of grace). With the same boot the grace holds.
func TestRebootSkipsStartGrace(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sameBoot bool
	}{{"reboot", false}, {"same-boot", true}} {
		t.Run(tc.name, func(t *testing.T) {
			r1 := newRig(t, 80, tinyBudget)
			r1.run(10 * time.Minute)
			prev := r1.state()
			r2 := buildRig(t, 81, time.Unix(0, prev.Extra.LastWallNs).Add(time.Hour), tinyBudget)
			if tc.sameBoot {
				r2.w.BootUs = r1.w.BootUs
			}
			r2.sink.Restore(prev)
			r2.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
			r2.w.SetMode("owner", true)
			r2.start()
			r2.run(20 * time.Minute)
			r2.noViolations()
			removed := len(r2.w.Removals) > 0
			if removed == tc.sameBoot {
				t.Fatalf("removals %d within 20 minutes of start; log:\n%s", len(r2.w.Removals), tail(r2.log.String(), 1500))
			}
			if tc.sameBoot != reasonsHave(r2, "start grace") {
				t.Errorf("reasons %q", r2.state().Extra.Reasons)
			}
		})
	}
}

// Phase A follow-up: a Pod update or reinstall stops the daemon (SIGTERM)
// and launchd starts the new one seconds later. That handover gets only what
// was left of the start grace, so an over-budget cache keeps shrinking (18.10:
// trimming stopped for 2 h at 48 GB after each restart). A crash, a gap over 2
// minutes, a clock set back meanwhile, an observe run or another cache before
// keep the grace.
func TestHandoverSkipsStartGrace(t *testing.T) {
	for _, tc := range []struct {
		name     string
		clean    bool
		gap      time.Duration
		prep     func(r *rig)  // before the first run
		between  func(r *rig)  // while no daemon runs
		first    time.Duration // the first run's length; default past its grace
		handover bool
	}{
		{name: "clean-stop", clean: true, gap: 30 * time.Second, handover: true},
		{name: "clean-stop-at-once", clean: true, handover: true},
		{name: "clean-stop-2min", clean: true, gap: 2 * time.Minute, handover: true},
		{name: "sigkill", gap: 30 * time.Second},
		{name: "gap-3min", clean: true, gap: 3 * time.Minute},
		{name: "clock-set-back", clean: true, gap: 30 * time.Second, between: func(r *rig) { r.w.StepClock(-time.Minute) }},
		{name: "previous-observe", clean: true, gap: 30 * time.Second, prep: func(r *rig) { r.w.SetMode("observe", true) }},
		{name: "other-cache", clean: true, gap: 30 * time.Second, between: func(r *rig) { r.cfg.CacheDir = "/sim/other-go-build" }},
		{name: "stopped-inside-grace", clean: true, gap: 30 * time.Second, first: 30 * time.Minute, handover: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := buildRig(t, 83, simStart, tinyBudget)
			r.w.SetMode("owner", true)
			if tc.prep != nil {
				tc.prep(r)
			}
			r.start()
			first := r.cfg.Limits.Window + time.Minute
			if tc.first != 0 {
				first = tc.first
			}
			r.run(first)
			if tc.clean {
				r.stop()
			}
			r.idle(tc.gap)
			if tc.between != nil {
				tc.between(r)
			}
			r.place(200, cachesim.Archive, 5_000_000, 72*time.Hour)
			r.w.SetMode("owner", true)
			r.start()
			if tc.first != 0 {
				// The grace belongs to the ownership episode: the rest of it carries over.
				left := r.cfg.Limits.Window - tc.first - tc.gap
				r.run(left - 2*time.Minute)
				r.noViolations()
				if len(r.w.Removals) != 0 || !r.logHas("handover from pid") || !reasonsHave(r, "start grace until") {
					t.Fatalf("removals %d with %s of the stopped run's grace left, reasons %q; log:\n%s",
						len(r.w.Removals), left, r.state().Extra.Reasons, tail(r.log.String(), 1500))
				}
				r.run(25 * time.Minute)
				r.noViolations()
				if len(r.w.Removals) == 0 || reasonsHave(r, "start grace until") {
					t.Fatalf("removals %d after the carried grace, reasons %q; log:\n%s",
						len(r.w.Removals), r.state().Extra.Reasons, tail(r.log.String(), 1500))
				}
				return
			}
			r.run(20 * time.Minute)
			r.noViolations()
			if removed := len(r.w.Removals) > 0; removed != tc.handover {
				t.Fatalf("removals %d within 20 minutes of start, handover %v; log:\n%s", len(r.w.Removals), tc.handover, tail(r.log.String(), 1500))
			}
			if tc.handover != reasonsHave(r, "handover from pid") || tc.handover == reasonsHave(r, "start grace until") {
				t.Errorf("reasons %q", r.state().Extra.Reasons)
			}
			if tc.handover != r.logHas("handover from pid") {
				t.Errorf("handover line in the log %v, want %v:\n%s", r.logHas("handover from pid"), tc.handover, tail(r.log.String(), 1500))
			}
		})
	}
}

// The handover keeps what the process tracker knew: a go process the stopped
// run saw exit still counts for 45 minutes after its exit, so the 5 h window
// it set holds for 45 minutes after the restart. An entry idle 3 h (outside
// the 2 h window, inside the carried 5 h) survives that long, then goes.
func TestHandoverCarriesWindow(t *testing.T) {
	r := newRig(t, 84, tinyBudget)
	r.warm()
	l := r.cfg.Limits
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Child: "compile", Life: 2 * time.Minute})
	p.Start -= int64(5*time.Hour - l.ProcessMargin - 2*time.Minute) // 5 h window just before it exits
	r.run(2*time.Minute + 30*time.Second)
	if r.w.Live() != 0 {
		t.Fatalf("%d processes alive before the stop", r.w.Live())
	}
	if got := time.Duration(r.state().Extra.WindowSeconds) * time.Second; got < 5*time.Hour {
		t.Fatalf("window %s before the stop, want 5 h from the process that just exited (reason %q)", got, r.state().Extra.WindowReason)
	}
	r.stop()
	r.idle(20 * time.Second)
	kept := r.place(50, cachesim.Archive, 1_000_000, 3*time.Hour)
	junk := r.place(50, cachesim.Archive, 1_000_000, 72*time.Hour)
	r.start()
	r.run(l.ExitGrace - 2*time.Minute)
	r.noViolations()
	if n := outputsGone(r.w, junk); n != len(junk) {
		t.Fatalf("%d of %d week-old entries evicted after the handover: the start grace held; log:\n%s", n, len(junk), tail(r.log.String(), 1500))
	}
	if n := outputsGone(r.w, kept); n != 0 {
		t.Fatalf("%d entries idle 3 h evicted within the carried window; log:\n%s", n, tail(r.log.String(), 1500))
	}
	if got := time.Duration(r.state().Extra.WindowSeconds) * time.Second; got < 5*time.Hour || !reasonsHave(r, "the window is at least 5h0m0s") {
		t.Errorf("window %s (reason %q), reasons %q", got, r.state().Extra.WindowReason, r.state().Extra.Reasons)
	}
	r.run(10 * time.Minute)
	r.noViolations()
	if n := outputsGone(r.w, kept); n != len(kept) {
		t.Errorf("%d of %d entries idle 3 h evicted once the carried window ended", n, len(kept))
	}
	if got := time.Duration(r.state().Extra.WindowSeconds) * time.Second; got != l.Window || reasonsHave(r, "handover from pid") {
		t.Errorf("window %s after the carry, reasons %q", got, r.state().Extra.Reasons)
	}
}

// prioLog records each priority change with how far behind the loop was.
type prioLog struct {
	inner cachesim.Prio
	r     *rig
	calls []prioCall
}

type prioCall struct {
	bg         bool
	indexTicks int  // ticks into an incomplete initial index, 0 once complete
	overBudget bool // indexed, past the grace, over budget with removals planned
}

func (p *prioLog) Background(on bool) {
	p.inner.Background(on)
	c := p.r.c
	if c == nil {
		return
	}
	over := c.idx.Complete() && !c.inGrace() && c.idx.Size() > c.limits().Budget && c.plan.Bytes > 0
	p.calls = append(p.calls, prioCall{on, c.indexTicks, over})
}

// NOTICED 1 of S9: at load 60-130 the background band starved the loop. A
// slow initial index (every call 50 ms, 10k files) leaves the band after
// lagIndexTicks; then, on a calmer disk, an over-budget cache with removals
// planned keeps it out until the cache is back under budget, and it returns
// to the band.
func TestLoopLeavesBackgroundBandWhenBehind(t *testing.T) {
	r := buildRig(t, 82, simStart, func(c *Config) { c.Limits.Budget = 4 * GB })
	p := &prioLog{inner: cachesim.Prio{W: r.w}, r: r}
	r.cfg.Prio = p
	r.w.OpCost = 50 * time.Millisecond
	r.place(10_000, cachesim.Archive, 1_000_000, 72*time.Hour) // 10 GB, 6 over budget
	r.w.SetMode("owner", true)
	r.start()
	for i := 0; i < 600 && !r.c.idx.Complete(); i++ {
		r.run(10 * time.Second)
	}
	r.w.OpCost = time.Millisecond
	r.run(r.cfg.Limits.Window + time.Hour)
	r.noViolations()
	late, lateBG, over, overBG := 0, 0, 0, 0
	for _, c := range p.calls {
		if c.indexTicks > lagIndexTicks {
			late++
			if c.bg {
				lateBG++
			}
		}
		if c.overBudget {
			over++
			if c.bg {
				overBG++
			}
		}
	}
	if late == 0 || lateBG > 0 {
		t.Errorf("a slow index past %d ticks still ran in the background band: %d of %d changes", lagIndexTicks, lateBG, late)
	}
	// The plan can turn over budget within a tick; the band follows next tick.
	if over < 10 || overBG > 2 {
		t.Errorf("an over-budget cache with removals planned ran in the background band: %d of %d changes", overBG, over)
	}
	if size := r.w.CacheBytes(); size > 4*GB {
		t.Errorf("cache %s after 3 h past the grace, budget 4 GB", gbf(size))
	}
	if !strings.HasSuffix(strings.TrimSpace(lastLine(r.log.String(), "loop ")), "background band again") {
		t.Errorf("the loop did not go back to the background band once caught up:\n%s", tail(r.log.String(), 2000))
	}
}

// lastLine is the last line of s containing sub.
func lastLine(s, sub string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.Contains(lines[i], sub) {
			return lines[i]
		}
	}
	return ""
}
