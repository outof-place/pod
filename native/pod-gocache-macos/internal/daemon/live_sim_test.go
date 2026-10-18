package daemon

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachesim"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// newLiveRig is newRig with the shared state on: go processes spawned with
// Client: true run through the client model and pin what they are handed.
func newLiveRig(t testing.TB, seed int64, tweak func(*Config)) *rig {
	r := buildRig(t, seed, simStart, tweak)
	r.cfg.Shared = r.w.Shared()
	r.start()
	return r
}

func (r *rig) clientFailures() []cachesim.Failure {
	var out []cachesim.Failure
	for _, f := range r.w.Failures {
		if f.Client {
			out = append(out, f)
		}
	}
	return out
}

func (r *rig) noClientFailures() {
	r.t.Helper()
	if fs := r.clientFailures(); len(fs) > 0 {
		r.t.Fatalf("%d client lookups failed, first %+v\nlog tail:\n%s", len(fs), fs[0], tail(r.log.String(), 2000))
	}
}

func actionRel(a *cachesim.Action) string { rel, _ := a.Rels(); return rel }
func outputRel(a *cachesim.Action) string { _, rel := a.Rels(); return rel }

// hardTierSetup: owner mode past the grace with plenty of disk, one entry
// used 50 minutes ago (Go's hourly refresh skips it) and week-old junk, all
// indexed and published. hardTier then drops free disk to 9 GB: the hard
// tier's 30 minute window, processes ignored, and more needed than the
// cache holds.
func hardTierSetup(t *testing.T, seed int64) (*rig, *cachesim.Action) {
	r := newLiveRig(t, seed, nil)
	r.warm()
	x := r.place(1, cachesim.Archive, 50_000_000, 50*time.Minute)[0]
	r.place(20, cachesim.Archive, 5_000_000, 72*time.Hour)
	r.run(time.Minute)
	return r, x
}

func (r *rig) hardTier() { r.setFree(9 * GB) }

// S2 (a): a client read X's -a just before the daemon removed it and pins
// the output just after; the output, queued for removal, is kept until the
// client exits, then removed.
func TestS9InterleavingPinAfterActionRemoved(t *testing.T) {
	r, x := hardTierSetup(t, 21)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 40 * time.Minute, Client: true})
	raced := false
	r.c.cfg.OnEvict = func(e Eviction) {
		if e.Rel == actionRel(x) && !raced {
			raced = true
			r.w.ClientRace(p, x)
		}
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if !raced {
		t.Fatal("X's -a was never removed: the interleaving did not happen")
	}
	if !r.w.Exists(outputRel(x)) {
		t.Fatal("the output a live client pinned was removed")
	}
	if r.c.live.skipped == 0 {
		t.Fatal("no removal was skipped for a pin")
	}
	r.run(time.Hour)
	r.noViolations()
	r.noClientFailures()
	if r.w.Exists(outputRel(x)) {
		t.Fatal("the pin outlived its process")
	}
}

// S2 (b): a client that pins inside the handshake, after the daemon drained
// and before it unlinks, sees the output dying and answers a miss.
func TestS9InterleavingPinInsideHandshake(t *testing.T) {
	r, x := hardTierSetup(t, 22)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: time.Hour, Client: true})
	tried, sawDying := false, false
	r.c.cfg.BeforeRemoveOutput = func(id [32]byte) {
		if id == x.Out && !tried {
			tried = true
			sawDying = r.w.ClientPin(p, x)
		}
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if !tried {
		t.Fatal("X's output was never about to be removed")
	}
	if !sawDying {
		t.Fatal("a pin taken after the drain did not see the batch: the daemon would delete what the client serves")
	}
	r.noViolations()
	r.noClientFailures()
}

// S2 (b'): a client that pins after the batch is published but before the
// drain sees it dying, and the drain sees its pin: both protections hold.
func TestS9InterleavingPinBeforeDrain(t *testing.T) {
	r, x := hardTierSetup(t, 23)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: time.Hour, Client: true})
	sh := r.w.Shared()
	tried, sawDying := false, false
	r.c.cfg.OnEvict = func(e Eviction) {
		if e.Rel == actionRel(x) {
			sh.OnBegin = func() {
				if !tried {
					tried = true
					sawDying = r.w.ClientPin(p, x)
				}
			}
		}
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if !tried || !sawDying {
		t.Fatalf("tried=%v sawDying=%v", tried, sawDying)
	}
	if !r.w.Exists(outputRel(x)) {
		t.Fatal("the drain after the batch missed a pin taken before it")
	}
}

// S5: the daemon stops (SIGSTOP, starvation) between the drain and an
// unlink for longer than BatchLife. A client then ignores the stale batch
// and serves the output, so the daemon, resuming, must not unlink anything
// in that batch: the output is planned again and the client's pin keeps it.
func TestS5StalledBatchUnlinksNothing(t *testing.T) {
	r, x := hardTierSetup(t, 25)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 40 * time.Minute, Client: true})
	stalled, sawDying := false, true
	r.c.cfg.BeforeRemoveOutput = func(id [32]byte) {
		if id == x.Out && !stalled {
			stalled = true
			r.w.Stall(livestate.BatchLife + time.Second)
			sawDying = r.w.ClientPin(p, x)
			r.w.ClientRace(p, x) // serves it: go reads the -d later
		}
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if !stalled || sawDying {
		t.Fatalf("stalled=%v sawDying=%v: the client did not meet a stale batch", stalled, sawDying)
	}
	if !r.w.Exists(outputRel(x)) {
		t.Fatal("the daemon unlinked an output in a batch clients had stopped honoring")
	}
	r.run(time.Hour)
	r.noViolations()
	r.noClientFailures()
}

// S2 (c): the daemon removed X's -a and has not unpublished it yet; a client
// looking X up finds the -a gone and treats it as a miss, never a hit.
func TestS9InterleavingStaleIndexEntry(t *testing.T) {
	r, x := hardTierSetup(t, 24)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: time.Hour, Client: true})
	looked := false
	r.c.cfg.OnEvict = func(e Eviction) {
		if e.Rel == actionRel(x) && !looked {
			looked = true
			r.w.Lookup(p, x)
		}
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if !looked || r.w.GoneMisses == 0 {
		t.Fatalf("looked=%v goneMisses=%d: the stale entry was not exercised", looked, r.w.GoneMisses)
	}
	r.noViolations()
	r.noClientFailures()
}

// S9 (amended by B1): in the hard tier a pinned output survives while its go
// process lives, though link reads it later than the tier window after the
// lookup. The same build without the client loses it (sabotage).
func TestS9PinnedOutputSurvivesHardTier(t *testing.T) {
	run := func(client bool) *rig {
		r, d := hardTierSetup(t, 31)
		p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 50 * time.Minute, Client: client})
		r.w.Lookup(p, d)
		r.w.UseAt(p, outputRel(d), r.w.Now()+45*time.Minute)
		r.hardTier()
		r.run(time.Hour)
		r.noViolations()
		return r
	}
	r := run(true)
	r.noClientFailures()
	if r.w.FastHits == 0 {
		t.Fatal("the lookup did not use the published index")
	}
	if len(r.w.PinnedRemovals) > 0 {
		t.Fatalf("pinned output removed in the hard tier: %+v", r.w.PinnedRemovals[0])
	}
	if s := run(false); len(s.w.Failures) == 0 {
		t.Fatal("without the client the build lost nothing: the test proves nothing")
	}
}

// The same with an output produced by a put early in the same process (go
// list -export reads it at the end), and with an output another, idle -a
// shares: pins are keyed by output, so that whole unit stays too.
func TestS9PinnedPutAndSharedOutputs(t *testing.T) {
	r := newLiveRig(t, 32, nil)
	r.warm()
	r.place(20, cachesim.Archive, 5_000_000, 72*time.Hour)
	fresh := r.w.NewAction(cachesim.Archive, 30_000_000) // not in the cache: compiled and put
	shared := r.place(1, cachesim.Archive, 40_000_000, 50*time.Minute)[0]
	twin := &cachesim.Action{ID: [32]byte{1, 2, 3}, Out: shared.Out, Size: shared.Size, Kind: cachesim.Archive}
	r.w.Place(twin, 72*time.Hour) // another -a for the same output, idle for days
	r.run(time.Minute)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "list", Life: 55 * time.Minute, Export: true, Client: true})
	r.w.Lookup(p, fresh)
	r.w.Lookup(p, shared)
	r.w.UseAt(p, outputRel(shared), r.w.Now()+50*time.Minute)
	r.w.UseAt(p, outputRel(fresh), r.w.Now()+50*time.Minute)
	r.run(time.Minute)
	r.hardTier()
	r.run(30 * time.Minute)
	if !r.w.Exists(actionRel(twin)) || !r.w.Exists(outputRel(shared)) {
		t.Fatal("a unit whose output a live client pinned was evicted")
	}
	r.run(time.Hour)
	r.noViolations()
	r.noClientFailures()
	if r.w.Exists(outputRel(fresh)) || r.w.Exists(actionRel(twin)) {
		t.Fatal("pins outlived the process")
	}
}

// B1: pins give way in the emergency tier, and only for what every unpinned
// candidate cannot cover; with enough unpinned bytes nothing pinned goes.
func TestB1PinsGiveWayOnlyInEmergency(t *testing.T) {
	run := func(free int64, junk int) *rig {
		r := newLiveRig(t, 41, nil)
		r.warm()
		pinned := r.place(5, cachesim.Archive, 200_000_000, 50*time.Minute)
		r.place(junk, cachesim.Archive, 100_000_000, 72*time.Hour)
		r.run(time.Minute)
		p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 3 * time.Hour, Client: true})
		for _, a := range pinned {
			r.w.Lookup(p, a)
		}
		r.run(time.Minute)
		r.setFree(free)
		r.run(15 * time.Minute)
		r.noViolations()
		return r
	}
	// Emergency (5 GB free: 3 GB needed) with 1 GB unpinned: pins give way.
	r := run(5*GB, 10)
	if len(r.w.PinnedRemovals) == 0 {
		t.Fatal("pins never gave way although free disk stayed in the emergency tier")
	}
	for _, rm := range r.w.PinnedRemovals {
		if rm.FreeAtCut >= r.cfg.Limits.EmergencyFloor+r.cfg.Limits.Hysteresis {
			t.Fatalf("pinned output removed outside the emergency tier: %+v", rm)
		}
	}
	// Emergency with 4 GB unpinned: nothing pinned goes.
	if r := run(5*GB, 40); len(r.w.PinnedRemovals) > 0 {
		t.Fatalf("pinned output removed while unpinned candidates remained: %+v", r.w.PinnedRemovals[0])
	}
	// Hard tier with too little unpinned: still nothing pinned goes.
	if r := run(9*GB, 2); len(r.w.PinnedRemovals) > 0 {
		t.Fatalf("pinned output removed in the hard tier: %+v", r.w.PinnedRemovals[0])
	}
}

// S10: S2's emergency replay (12 GB free; builds add 1 GB a minute for 25
// minutes; something outside writes 10 GB in 3 minutes) with 35 sessions,
// each a 20 minute go test pinning everything it touches: 20 GB of entries
// used 50 minutes ago, which the emergency window alone would let go. Pins
// keep at most the cap, give way in the emergency tier, and free disk never
// runs out.
func TestS10PinsNeverDriveDiskToZero(t *testing.T) {
	r := newLiveRig(t, 51, nil)
	w := r.w
	rng := w.Rand()
	for range 340 {
		r.place(1, cachesim.Archive, 100_000_000, time.Duration(2+rng.Intn(160))*time.Hour)
	}
	touched := r.place(200, cachesim.Archive, 100_000_000, 50*time.Minute)
	w.SetCapacity(w.CacheBytes() + 12*GB)
	w.SetMode("owner", true)
	r.run(time.Minute)
	start := w.Now()
	low := minFree(w, start+40*time.Minute)
	for i := range 35 {
		p := w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "longtest", Life: 20 * time.Minute, Client: true})
		for k := range 40 {
			a := touched[(i*37+k*11)%len(touched)]
			w.At(start+time.Duration(k)*time.Second, func() { w.Lookup(p, a) })
		}
	}
	for m := range 25 {
		w.At(start+time.Duration(m)*time.Minute, func() { r.place(10, cachesim.Archive, 100_000_000, 0) })
	}
	ext := int64(0)
	for s := range 30 {
		w.At(start+5*time.Minute+time.Duration(s)*6*time.Second, func() {
			ext += 10 * GB / 30
			w.SetExternal(ext)
		})
	}
	maxPinned, overCap := int64(0), int64(0)
	for range 40 * 60 / 10 {
		r.run(10 * time.Second)
		if l := r.state().Extra.Live; l != nil {
			maxPinned, overCap = max(maxPinned, l.Pinned), max(overCap, l.OverCap)
		}
	}
	r.noViolations()
	if *low <= 0 {
		t.Fatalf("free disk reached %s\n%s", gbf(*low), tail(r.log.String(), 4000))
	}
	if maxPinned > r.cfg.PinCap {
		t.Fatalf("pins kept %s, over the %s cap", gbf(maxPinned), gbf(r.cfg.PinCap))
	}
	if overCap == 0 {
		t.Fatal("the cap never applied: the run proves nothing")
	}
	t.Logf("lowest free %s, most pinned %s (cap %s), over cap %s, pinned removed %d, fast hits %d",
		gbf(*low), gbf(maxPinned), gbf(r.cfg.PinCap), gbf(overCap), len(w.PinnedRemovals), w.FastHits)
}

// S7 (e): the daemon stopped for 20 minutes while clients served and pinned;
// when it resumes at 6 GB free, its first cycle drains the pins before it
// removes anything. The served entries are the oldest candidates (go left
// their mtimes, under an hour old), so a daemon that missed the pins would
// remove them first: the same run without the client does (sabotage).
func TestS7StoppedDaemonDrainsBeforeEvicting(t *testing.T) {
	run := func(client bool) (*rig, []*cachesim.Action) {
		r := newLiveRig(t, 61, nil)
		r.warm()
		served := r.place(40, cachesim.Archive, 20_000_000, 50*time.Minute)
		r.place(60, cachesim.Archive, 100_000_000, 5*time.Minute)
		r.run(time.Minute)
		stopped := func() time.Duration { return time.Second }
		for i := range 4 {
			p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: time.Hour, Client: client})
			for _, a := range served[i*10 : i*10+10] {
				r.w.Lookup(p, a)
				r.w.UseAt(p, outputRel(a), r.w.Now()+30*time.Minute)
			}
		}
		r.w.Run(r.w.Now()+20*time.Minute, stopped)
		r.setFree(6 * GB)
		r.run(2 * time.Minute)
		return r, served
	}
	gone := func(r *rig, served []*cachesim.Action) int {
		n := 0
		for _, a := range served {
			if !r.w.Exists(outputRel(a)) {
				n++
			}
		}
		return n
	}
	r, served := run(true)
	if len(r.w.PinnedRemovals) > 0 || gone(r, served) > 0 {
		t.Fatalf("%d served entries evicted in the first cycle after the stop", gone(r, served))
	}
	r.run(time.Hour)
	r.noViolations()
	r.noClientFailures()
	if r.w.FastHits == 0 {
		t.Fatal("the lookups did not use the published index")
	}
	sab, served := run(false)
	if gone(sab, served) == 0 {
		t.Fatal("without pins the served entries survive too: the scenario proves nothing")
	}
}

// S11: the daemon restarts mid-build; the new one adopts the clients' pins
// before its first removal.
func TestS11RestartAdoptsPins(t *testing.T) {
	r, d := hardTierSetup(t, 71)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 50 * time.Minute, Client: true})
	r.w.Lookup(p, d)
	r.w.UseAt(p, outputRel(d), r.w.Now()+45*time.Minute)
	r.hardTier()
	r.run(5 * time.Second)
	r.start() // killed and started again by launchd
	r.run(time.Hour)
	r.noViolations()
	r.noClientFailures()
	if len(r.w.PinnedRemovals) > 0 {
		t.Fatal("a restarted daemon removed a pinned output")
	}
}

// S17: an 8 hour sleep with the go process alive leaves its pins valid
// (awake time stopped); a clock step back does not extend a pin past its
// expiry.
func TestS17PinsAcrossSleepAndClockSteps(t *testing.T) {
	t.Run("sleep", func(t *testing.T) {
		r, d := hardTierSetup(t, 81)
		p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 50 * time.Minute, Client: true})
		r.w.Lookup(p, d)
		r.run(time.Minute)
		r.w.Sleep(8 * time.Hour)
		r.hardTier()
		r.w.UseAt(p, outputRel(d), r.w.Now()+20*time.Minute)
		r.run(30 * time.Minute)
		r.noViolations()
		r.noClientFailures()
	})
	t.Run("clock-steps", func(t *testing.T) {
		r := newLiveRig(t, 82, func(c *Config) { c.PinExpiry = 20 * time.Minute })
		r.warm()
		d := r.place(1, cachesim.Archive, 50_000_000, 50*time.Minute)[0]
		r.run(time.Minute)
		p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 2 * time.Hour, Client: true})
		r.w.Lookup(p, d)
		r.run(time.Minute)
		r.w.StepClock(3 * time.Hour)
		r.run(time.Minute)
		if !r.c.live.keeps(d.Out) {
			t.Fatal("a clock step forward expired a pin early")
		}
		r.w.StepClock(-6 * time.Hour)
		r.run(25 * time.Minute)
		if r.c.live.keeps(d.Out) {
			t.Fatal("a pin outlived its expiry in awake time after the clock stepped back")
		}
	})
}

// S16/B7: records a client forges (pins of outputs that do not exist, hints
// for actions that do not exist) never publish anything and never protect
// beyond the cap.
func TestS16ForgedRecordsPublishNothing(t *testing.T) {
	r := newLiveRig(t, 91, func(c *Config) { c.PinCap = GB })
	r.warm()
	real := r.place(5, cachesim.Archive, 400_000_000, 50*time.Minute)
	r.run(time.Minute)
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "build", Life: 2 * time.Hour, Client: true})
	for i := range 2000 {
		fake := &cachesim.Action{Kind: cachesim.Archive, Size: 1}
		fake.ID[0], fake.ID[1], fake.ID[2] = byte(i), byte(i>>8), 0xee
		fake.Out[0], fake.Out[1], fake.Out[2] = byte(i), byte(i>>8), 0xef
		r.w.ClientPin(p, fake)
	}
	for _, a := range real {
		r.w.Lookup(p, a)
	}
	r.run(time.Minute)
	entries, _, _ := r.cfg.Shared.IndexStats()
	if entries != r.c.idx.Actions() {
		t.Fatalf("published %d entries, the cache has %d -a files", entries, r.c.idx.Actions())
	}
	r.hardTier()
	r.run(20 * time.Minute)
	if st := r.state(); st.Extra.Live.Pinned > GB {
		t.Fatalf("pins protect %s, over the 1 GB cap", gbf(st.Extra.Live.Pinned))
	}
	r.noViolations()
}

// The publisher follows the cache: entries the daemon read exactly are
// published, rewritten ones republished, vanished ones withdrawn.
// A go command often ends before the daemon's next drain. Its requests to
// re-read entries (here: an -a whose mtime changed, found stale) still reach
// the daemon, which republishes the entry well before its periodic re-stat.
func TestEndedClientsHintsCount(t *testing.T) {
	r := newLiveRig(t, 96, nil)
	// Placed under an hour ago: the simulated -a time stays positive, so the
	// entries parse and get published.
	as := r.place(3000, cachesim.Archive, 100_000, 30*time.Minute)
	for i := 0; i < 30; i++ {
		if e, _, _ := r.cfg.Shared.IndexStats(); e == len(as) {
			break
		}
		r.run(time.Minute)
	}
	x := as[1234]
	sh := r.w.Shared()
	before, ok := sh.Published(x.ID)
	if !ok {
		e, _, _ := r.cfg.Shared.IndexStats()
		exact := 0
		r.c.idx.EachExact(func(index.ID, index.Exact) { exact++ })
		t.Fatalf("x not published (%d entries published, live %q open %v, index complete %v, %d actions, %d exact)", e, r.c.live.reason, r.c.live.open, r.c.idx.Complete(), r.c.idx.Actions(), exact)
	}
	r.w.SetTimes(actionRel(x), r.w.WallNs()) // go's markUsed in another process
	p := r.w.Spawn(cachesim.ProcSpec{Comm: "go", Kind: "list", Life: time.Hour, Client: true})
	r.w.Lookup(p, x)
	r.w.Kill(p)
	r.run(5 * time.Second)
	st, _ := r.w.Lstat(actionRel(x))
	after, ok := sh.Published(x.ID)
	if !ok || after.Ctime != st.Ctime || after.Ctime == before.Ctime {
		t.Fatalf("published %+v (ok %v) for an -a with ctime %d (was %d): the ended client's request was lost", after, ok, st.Ctime, before.Ctime)
	}
}

func TestPublisherFollowsTheIndex(t *testing.T) {
	r := newLiveRig(t, 95, nil)
	as := r.place(30, cachesim.Archive, 1_000_000, time.Hour)
	r.run(time.Minute)
	if e, _, _ := r.cfg.Shared.IndexStats(); e != 30 {
		t.Fatalf("published %d of 30", e)
	}
	r.w.GoClean()
	r.run(2 * time.Minute)
	if e, _, _ := r.cfg.Shared.IndexStats(); e != 0 {
		t.Fatalf("%d entries still published after go clean", e)
	}
	_ = as
}

var dstLive struct {
	sync.Mutex
	fast, disk, gone, dying, batches, pressured, pinnedGone, builtinFailures int
}

// TestDSTClients is TestDSTRandom with most go commands running through the
// client: on top of S2's invariants, a pinned output goes only in the
// emergency tier, and client builds fail only there.
func TestDSTClients(t *testing.T) {
	seeds := envInt("POD_GOCACHE_DST_SEEDS", 6)
	hours := envInt("POD_GOCACHE_DST_HOURS", 3)
	first := envInt("POD_GOCACHE_DST_FIRST", 1)
	t.Run("all", func(t *testing.T) {
		for s := first; s < first+seeds; s++ {
			t.Run(fmt.Sprint("seed", s), func(t *testing.T) {
				t.Parallel()
				clientDay(t, int64(s), time.Duration(hours)*time.Hour)
			})
		}
	})
	t.Logf("DST clients: %d fast hits, %d disk hits, %d index-gone misses, %d dying misses, %d handshakes, %d ticks with pins in the hard or emergency tier, %d pinned outputs removed (emergency give-way), %d built-in build failures (relaxed tiers), 0 client build failures outside the emergency tier",
		dstLive.fast, dstLive.disk, dstLive.gone, dstLive.dying, dstLive.batches, dstLive.pressured, dstLive.pinnedGone, dstLive.builtinFailures)
	if seeds >= 3 && (dstLive.fast == 0 || dstLive.batches == 0 || dstLive.pressured == 0 || dstLive.builtinFailures == 0) {
		t.Error("the shared state was never exercised under pressure: the run proves nothing")
	}
}

func clientDay(t *testing.T, seed int64, active time.Duration) {
	r := newLiveRig(t, seed, func(c *Config) { c.PinCap = 1 << 50 })
	w := r.w
	rng := w.Rand()
	wl := w.NewWorkload(3000)
	wl.ClientP = 0.7
	w.Populate(wl, 1500, 7*24*time.Hour)
	w.SetCapacity(200 * GB)
	setFree := func(free int64) {
		w.SetExternal(0)
		w.SetExternal(max(0, w.FreeNow()-free))
	}
	setFree(40 * GB)
	end := w.Now() + active
	w.Start(wl, end)
	restart := false
	pressured := 0
	var wander func()
	wander = func() {
		if w.Now() >= end {
			return
		}
		levels := []int64{40 * GB, 16 * GB, 12 * GB, 9 * GB, 8*GB - 1, 6 * GB, 5 * GB}
		setFree(levels[rng.Intn(len(levels))])
		w.After(time.Duration(5+rng.Intn(30))*time.Minute, wander)
	}
	w.After(time.Duration(rng.Intn(20))*time.Minute, wander)
	w.After(time.Duration(rng.Intn(30))*time.Minute, func() { w.SetMode("owner", true) })
	var trouble func()
	trouble = func() {
		if w.Now() >= end {
			return
		}
		switch rng.Intn(5) {
		case 0:
			w.Sleep(time.Duration(1+rng.Intn(10)) * time.Hour)
		case 1:
			w.StepClock(time.Duration(rng.Intn(7)-3) * time.Hour)
		case 2:
			restart = true
		}
		w.After(time.Duration(20+rng.Intn(60))*time.Minute, trouble)
	}
	w.After(time.Duration(rng.Intn(60))*time.Minute, trouble)
	tick := func() time.Duration {
		if restart {
			restart = false
			r.start()
		}
		d := r.c.tick()
		if r.c.tier >= evict.Hard && r.c.live.pinnedBytes > 0 {
			pressured++
		}
		return d
	}
	w.Run(end, tick)
	setFree(60 * GB)
	w.Run(w.Now()+10*time.Hour, tick)

	r.noViolations()
	emergency := r.cfg.Limits.EmergencyFloor + r.cfg.Limits.Hysteresis
	for _, rm := range w.PinnedRemovals {
		if rm.FreeAtCut >= emergency {
			t.Errorf("pinned output %s removed outside the emergency tier (free %s)", rm.Rel, gbf(rm.FreeAtCut))
		}
	}
	for _, f := range r.clientFailures() {
		if f.Class == "concurrent-put" {
			continue
		}
		if rm, ok := r.removalBefore(f.Rel, f.At); ok && rm.FreeAtCut < emergency {
			continue
		}
		t.Errorf("client build failed outside the emergency tier: %+v", f)
	}
	dstLive.Lock()
	defer dstLive.Unlock()
	dstLive.fast += w.FastHits
	dstLive.disk += w.DiskHits
	dstLive.gone += w.GoneMisses
	dstLive.dying += w.DyingMisses
	dstLive.batches += w.Shared().Batches
	dstLive.pressured += pressured
	dstLive.pinnedGone += len(w.PinnedRemovals)
	dstLive.builtinFailures += len(w.Failures) - len(r.clientFailures())
	t.Logf("seed %d: fast %d disk %d dying %d handshakes %d pressured ticks %d pinned removed %d failures %d (client %d)",
		seed, w.FastHits, w.DiskHits, w.DyingMisses, w.Shared().Batches, pressured, len(w.PinnedRemovals), len(w.Failures), len(r.clientFailures()))
}
