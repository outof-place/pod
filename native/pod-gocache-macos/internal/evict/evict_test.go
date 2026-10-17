package evict

import (
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
)

const mb = 1_000_000

// The tier table (amendment 1) with hysteresis (D3): a tier is entered below
// its threshold and left only at threshold + 1 GB.
// floors8and6 is Defaults with the hard and emergency floors the worked
// examples below were computed for.
func floors8and6() Limits {
	l := Defaults()
	l.HardFloor, l.EmergencyFloor = 8*GB, 6*GB
	return l
}

func TestNextTier(t *testing.T) {
	l := floors8and6()
	cases := []struct {
		prev Tier
		free int64
		want Tier
	}{
		{Normal, 15 * GB, Normal},
		{Normal, 15*GB - 1, Low},
		{Low, 15*GB + 500*mb, Low},
		{Low, 16 * GB, Normal},
		{Normal, 8*GB - 1, Hard},
		{Hard, 8*GB + 500*mb, Hard},
		{Hard, 9 * GB, Low},
		{Low, 8 * GB, Low},
		{Normal, 6*GB - 1, Emergency},
		{Emergency, 6*GB + 999*mb, Emergency},
		{Emergency, 7 * GB, Hard},
		{Emergency, 16 * GB, Normal},
		{Hard, 0, Emergency},
	}
	for _, c := range cases {
		if got := NextTier(c.prev, c.free, l); got != c.want {
			t.Errorf("NextTier(%s, %d) = %s, want %s", c.prev, c.free, got, c.want)
		}
	}
	if !Hard.FullSpeed() || !Emergency.FullSpeed() || Low.FullSpeed() || Normal.FullSpeed() {
		t.Error("full speed must be exactly the hard and emergency tiers")
	}
}

// Targets from the brief's formula: min(30, max(15, size - deficit)), with
// the relaxed stages only up to their threshold + 1 GB (D3).
func TestNeeds(t *testing.T) {
	l := floors8and6()
	cases := []struct {
		name        string
		size, free  int64
		tier        Tier
		e, h, n     int64
		target      int64
		description string
	}{
		{"plenty", 40 * GB, 100 * GB, Normal, 0, 0, 10 * GB, 30 * GB, "budget only"},
		{"under-budget", 20 * GB, 100 * GB, Normal, 0, 0, 0, 30 * GB, "nothing"},
		{"s23-first-start", 40 * GB, 11 * GB, Low, 0, 0, 10 * GB, 30 * GB, "min(30, max(15, 40-4))"},
		{"shrink", 20 * GB, 12 * GB, Low, 0, 0, 3 * GB, 17 * GB, "max(15, 20-3)"},
		{"cache-floor", 16 * GB, 12 * GB, Low, 0, 0, 1 * GB, 15 * GB, "max(15, 16-3)"},
		{"hard", 30 * GB, 7 * GB, Hard, 0, 2 * GB, 6 * GB, 22 * GB, "relaxed to 9 GB, then 6 GB more"},
		{"emergency", 30 * GB, 5 * GB, Emergency, 2 * GB, 2 * GB, 6 * GB, 20 * GB, "to 7, to 9, then 6 GB more"},
		{"hard-hysteresis", 30 * GB, 8*GB + 500*mb, Hard, 0, 500 * mb, 6 * GB, 23*GB + 500*mb, "still hard above 8 GB"},
	}
	for _, c := range cases {
		n := Needs(c.size, c.free, c.tier, l)
		if n.Emergency != c.e || n.Hard != c.h || n.Normal != c.n || n.Target != c.target {
			t.Errorf("%s (%s): got %+v, want e=%d h=%d n=%d target=%d", c.name, c.description, n, c.e, c.h, c.n, c.target)
		}
	}
}

func TestProcessWindow(t *testing.T) {
	l := Defaults()
	cases := []struct{ age, want time.Duration }{
		{-1, 2 * time.Hour},
		{30 * time.Minute, 2 * time.Hour},
		{time.Hour, 2*time.Hour + 5*time.Minute},
		{5 * time.Hour, 6*time.Hour + 5*time.Minute},
		{6 * time.Hour, 7*time.Hour + 5*time.Minute},
		{48 * time.Hour, 7*time.Hour + 5*time.Minute},
	}
	for _, c := range cases {
		if got := ProcessWindow(l, c.age); got != c.want {
			t.Errorf("ProcessWindow(%s) = %s, want %s", c.age, got, c.want)
		}
	}
}

var idSeq byte

func unit(bytes int64, age time.Duration) Candidate {
	idSeq++
	var id index.ID
	id[0], id[1] = idSeq, 0x5a
	return Candidate{Unit: index.Unit{ID: id, ABytes: 4096, DBytes: bytes - 4096, Refs: 1, HasOut: true, Out: id}, Age: age}
}

func planned(p Plan) map[index.ID]Stage {
	m := map[index.ID]Stage{}
	for _, u := range p.Units {
		m[u.ID] = u.Stage
	}
	return m
}

// D7 and S21: an older age bucket goes entirely before a younger one, larger
// first within a bucket.
func TestAssignAgeBucketsDominate(t *testing.T) {
	w := Windows{Normal: 2 * time.Hour, Hard: 30 * time.Minute, Emergency: 15 * time.Minute}
	archive := unit(1000*mb, 150*time.Minute)
	small := unit(500_000, 6*time.Hour)
	c := []Candidate{archive, small}
	var week []Candidate
	for i := 0; i < 200; i++ {
		week = append(week, unit(5*mb, 6*24*time.Hour+time.Duration(i)*time.Minute))
	}
	c = append(c, week...)
	Sort(c, AgeBuckets{}, w.Normal)
	p := Assign(c, Need{Normal: 900 * mb}, w, -1)
	got := planned(p)
	if _, ok := got[archive.ID]; ok {
		t.Error("the 1 GB archive idle 2.5 h was planned before week-old entries")
	}
	if _, ok := got[small.ID]; ok {
		t.Error("the small entry idle 6 h was planned before week-old entries")
	}
	if len(p.Units) != 180 || p.Bytes != 900*mb {
		t.Errorf("planned %d units, %d bytes; want 180 week-old units", len(p.Units), p.Bytes)
	}
	big := unit(50*mb, 2*24*time.Hour)
	little := unit(1*mb, 3*24*time.Hour)
	c2 := []Candidate{little, big}
	Sort(c2, AgeBuckets{}, w.Normal)
	if c2[0].ID != big.ID {
		t.Error("within the > 1 d bucket the larger entry must come first")
	}
}

// D3 and S6: what units older than the normal window free counts toward the
// relaxed needs too; a relaxed window serves only the rest.
func TestAssignRelaxedOnlyForTheClimb(t *testing.T) {
	w := Windows{Normal: 2 * time.Hour, Hard: 30 * time.Minute, Emergency: 15 * time.Minute}
	need := Need{Hard: 1100 * mb, Normal: 6 * GB}
	mk := func(old int) []Candidate {
		var c []Candidate
		for i := 0; i < old; i++ {
			c = append(c, unit(100*mb, 3*time.Hour))
		}
		for i := 0; i < 60; i++ {
			c = append(c, unit(100*mb, 61*time.Minute+time.Duration(i)*time.Minute))
		}
		for i := 0; i < 50; i++ {
			c = append(c, unit(100*mb, 31*time.Minute+time.Duration(i%29)*time.Minute))
		}
		Sort(c, AgeBuckets{}, w.Normal)
		return c
	}
	p := Assign(mk(30), need, w, -1)
	for _, u := range p.Units {
		if u.Stage != StageNormal {
			t.Fatalf("a %s-idle unit planned under the relaxed window although 3 GB idle > 2 h covers the climb", u.Age)
		}
	}
	p = Assign(mk(5), need, w, -1)
	var relaxed int64
	for _, u := range p.Units {
		if u.Stage == StageHard {
			relaxed += u.ABytes + u.DBytes
			if u.Age <= time.Hour {
				t.Errorf("a unit idle %s planned while units idle > 1 h remained", u.Age)
			}
		}
	}
	if relaxed < 600*mb || relaxed > 700*mb {
		t.Errorf("relaxed window planned %d bytes, want the 0.6 GB left after the old units (one unit over at most)", relaxed)
	}
}

// Shared outputs are counted once, by the unit that drops the last reference.
func TestAssignSharedOutput(t *testing.T) {
	var out index.ID
	out[0] = 0xee
	a1 := unit(4096, 3*time.Hour)
	a2 := unit(4096, 4*time.Hour)
	for _, a := range []*Candidate{&a1, &a2} {
		a.Out, a.Refs, a.DBytes = out, 2, 100*mb
	}
	c := []Candidate{a1, a2}
	Sort(c, AgeBuckets{}, 2*time.Hour)
	p := Assign(c, Need{Normal: GB}, Windows{Normal: 2 * time.Hour}, -1)
	if p.Bytes != 2*4096+100*mb {
		t.Errorf("planned %d bytes, want both -a files and the shared output once", p.Bytes)
	}
	p = Assign(c[:1], Need{Normal: GB}, Windows{Normal: 2 * time.Hour}, -1)
	if p.Bytes != 4096 {
		t.Errorf("one of two references planned %d bytes, want only its -a", p.Bytes)
	}
}

// The episode cap stops the plan, passed by one unit at most.
func TestAssignRoomCap(t *testing.T) {
	var c []Candidate
	for i := 0; i < 10; i++ {
		c = append(c, unit(100*mb, 3*time.Hour))
	}
	p := Assign(c, Need{Normal: GB}, Windows{Normal: 2 * time.Hour}, 250*mb)
	if len(p.Units) != 3 || !p.Capped {
		t.Errorf("room 250 MB planned %d units (capped %v), want 3", len(p.Units), p.Capped)
	}
	p = Assign(c, Need{Normal: GB}, Windows{Normal: 2 * time.Hour}, 0)
	if len(p.Units) != 0 || !p.Capped {
		t.Errorf("room 0 planned %d units", len(p.Units))
	}
}

// D5 finding: with W over 6 h the window is its own bucket bound. The hard
// tier needs 1.5 GB; a 1.5 GB unit idle 6.5 h (inside W) must not go under
// the relaxed window while units idle 10 to 20 h (outside W) can cover it.
func TestAssignWindowIsABucketBound(t *testing.T) {
	w := Windows{Normal: 7*time.Hour + 5*time.Minute, Hard: 30 * time.Minute, Emergency: 15 * time.Minute}
	inside := unit(1500*mb, 6*time.Hour+30*time.Minute)
	c := []Candidate{inside}
	for i := 0; i < 30; i++ {
		c = append(c, unit(100*mb, 10*time.Hour+time.Duration(i)*20*time.Minute))
	}
	Sort(c, AgeBuckets{}, w.Normal)
	p := Assign(c, Need{Hard: 1500 * mb}, w, -1)
	if _, ok := planned(p)[inside.ID]; ok {
		t.Fatal("the 1.5 GB unit inside W was planned under the relaxed window while units outside W were left")
	}
	if p.Bytes < 1500*mb || len(p.Units) != 15 {
		t.Errorf("planned %d units, %d bytes; want 15 units idle 10 to 20 h", len(p.Units), p.Bytes)
	}
	if ageBucket(6*time.Hour+30*time.Minute, w.Normal) == ageBucket(10*time.Hour, w.Normal) {
		t.Error("6.5 h (inside W) and 10 h (outside W) share a bucket")
	}
	if ageBucket(3*time.Hour, 2*time.Hour) != 3 || ageBucket(90*time.Minute, 2*time.Hour) != 4 || ageBucket(7*24*time.Hour, 2*time.Hour) != 0 {
		t.Error("with W = 2 h the buckets moved")
	}
}

// D4 (amended): a full 2 GB chunk that frees under 10% pauses for 10 minutes;
// free disk responding resumes it.
func TestEpisodeNoEffectPause(t *testing.T) {
	l := Defaults()
	var e Episode
	if e.Room() != -1 {
		t.Fatal("room outside an episode must be -1")
	}
	if !e.Update(Low, 12*GB, l) || e.Room() != 3*GB {
		t.Fatalf("episode at 12 GB free: room %d, want 3 GB", e.Room())
	}
	mono := time.Hour
	e.Evict(2*GB, 12*GB, 0, mono)
	if !e.Paused(mono) {
		t.Fatal("no settle after a 2 GB chunk")
	}
	if e.Observe(12*GB, 0, mono+time.Second, false) != Nothing {
		t.Fatal("judged before the settle ended")
	}
	if e.Observe(12*GB, 0, mono+6*time.Second, false) != NoEffectPaused || !e.Paused(mono+time.Minute) {
		t.Fatal("2 GB evicted with no free disk back did not pause")
	}
	if e.NoEffect.Evicted != 2*GB || e.NoEffect.FreeDelta != 0 || e.Confirmed != 0 {
		t.Errorf("no-effect record %+v, confirmed %d", e.NoEffect, e.Confirmed)
	}
	e.Observe(12*GB+300*mb, 0, mono+2*time.Minute, false)
	if e.Paused(mono + 2*time.Minute) {
		t.Error("free disk rising by 15% of the chunk must resume")
	}
	if e.Room() != GB {
		t.Errorf("room %d after 2 of 3 GB with nothing confirmed, want 1 GB", e.Room())
	}
	if !e.Update(Normal, 16*GB, l) || e.Active || e.Room() != -1 {
		t.Error("back to normal must end the episode")
	}
	// Bytes go added during the settle explain a smaller rise.
	e.Update(Low, 10*GB, l)
	e.Evict(2*GB, 10*GB, 0, mono)
	if e.Observe(10*GB+100*mb, 1900*mb, mono+6*time.Second, false) != Confirmed {
		t.Error("free +0.1 GB while go wrote 1.9 GB is an effect, not a pause")
	}
}

// D4 (amended), skeptic finding 1: removals free nothing while free disk
// swings 5.8 <-> 7.2 GB across the emergency line. The allowance stays at the
// largest deficit (9.2 GB) and each tier lifts a pause at most once.
func TestEpisodeSwingWithNoEffect(t *testing.T) {
	l := Defaults()
	var e Episode
	mono := time.Hour
	lifts := 0
	for i := 0; i < 40; i++ {
		free := int64(7200 * mb)
		if i%2 == 0 {
			free = 5800 * mb
		}
		pausedBefore := e.PausedUntil != 0
		e.Update(NextTier(e.tier, free, l), free, l)
		if pausedBefore && e.PausedUntil == 0 {
			lifts++
		}
		e.Observe(free, 0, mono, false)
		for room := e.Room(); room > 0 && !e.Paused(mono); room = e.Room() {
			e.Evict(min(room, 100*mb), free, 0, mono)
		}
		mono += 6 * time.Second
		e.Observe(free, 0, mono, false)
		mono += 2 * time.Minute
	}
	if e.Evicted > 9200*mb+100*mb {
		t.Errorf("evicted %d with no disk coming back, largest deficit 9.2 GB", e.Evicted)
	}
	if e.Allowance() != 9200*mb || e.Confirmed != 0 {
		t.Errorf("allowance %d confirmed %d, want 9.2 GB and nothing confirmed", e.Allowance(), e.Confirmed)
	}
	if lifts > 1 {
		t.Errorf("tier drops lifted the pause %d times; at most once per tier", lifts)
	}
}

// Removals free nothing, and someone else frees 3.2 GB while a chunk settles:
// free disk crossing a tier line spoils the measurement, so that rise is not
// taken for the chunk's effect and the allowance stays at the largest deficit.
func TestEpisodeTierRiseSpoilsChunk(t *testing.T) {
	l := Defaults()
	var e Episode
	mono := time.Hour
	free := int64(5800 * mb)
	e.Update(NextTier(Normal, free, l), free, l)
	e.Evict(2*GB, free, 0, mono)
	free = 9 * GB
	e.Update(NextTier(e.tier, free, l), free, l)
	if got := e.Observe(free, 0, mono+6*time.Second, false); got != Nothing || e.Confirmed != 0 {
		t.Fatalf("free disk rose 3.2 GB across the emergency and hard lines while a chunk settled: %v, confirmed %d", got, e.Confirmed)
	}
	free = 5800 * mb
	e.Update(NextTier(e.tier, free, l), free, l)
	if e.Allowance() != 9200*mb {
		t.Errorf("allowance %d, want the largest deficit 9.2 GB", e.Allowance())
	}
}

// D4 (amended), skeptic finding 2: removals free disk while something else
// eats it. Confirmed chunks widen the allowance, so it follows the deficit.
func TestEpisodeFollowsExternalGrowth(t *testing.T) {
	l := Defaults()
	var e Episode
	mono := time.Hour
	ext := int64(0)
	freeOf := func() int64 { return 14900*mb - ext + e.Evicted }
	for step := 0; step < 180; step++ { // 3 h, a minute a step
		ext += 37 * mb
		e.Update(NextTier(e.tier, freeOf(), l), freeOf(), l)
		e.Observe(freeOf(), 0, mono, false)
		before := freeOf()
		for room := e.Room(); room > 0 && !e.Paused(mono); room = e.Room() {
			e.Evict(min(room, 100*mb), before, 0, mono)
		}
		mono += time.Minute
	}
	e.Observe(freeOf(), 0, mono, false)
	if f := freeOf(); f < 14800*mb {
		t.Errorf("free disk %d after 6.6 GB eaten outside the cache; the episode should keep it near 15 GB (evicted %d, confirmed %d)", f, e.Evicted, e.Confirmed)
	}
	if e.Evicted > ext+200*mb {
		t.Errorf("evicted %d for %d eaten", e.Evicted, ext)
	}
}

// A smaller chunk is judged once eviction stopped for the settle time and
// nothing is queued; one that shows no effect is not counted.
func TestEpisodePartialChunk(t *testing.T) {
	l := Defaults()
	var e Episode
	mono := time.Hour
	e.Update(Low, 14*GB, l)
	e.Evict(300*mb, 14*GB, 0, mono)
	if e.Paused(mono) {
		t.Fatal("a 0.3 GB chunk must not settle-pause")
	}
	if e.Observe(14*GB, 0, mono+3*time.Second, false) != Nothing {
		t.Fatal("judged while eviction was still running")
	}
	if e.Observe(14*GB, 0, mono+6*time.Second, true) != Nothing {
		t.Fatal("judged while removals were queued")
	}
	if e.Observe(14*GB, 0, mono+7*time.Second, false) != NoEffectPartial || e.Confirmed != 0 || e.Paused(mono+8*time.Second) {
		t.Fatalf("partial chunk with no effect: confirmed %d paused %v", e.Confirmed, e.Paused(mono+8*time.Second))
	}
	e.Evict(300*mb, 14*GB, 0, mono+10*time.Second)
	if e.Observe(14*GB+290*mb, 0, mono+16*time.Second, false) != Confirmed || e.Confirmed != 300*mb {
		t.Fatalf("partial chunk that freed disk: confirmed %d", e.Confirmed)
	}
	e.Update(Low, 14*GB-500*mb+290*mb, l)
	if e.Allowance() != 1510*mb {
		t.Errorf("allowance %d, want max(1 GB, 1.21 GB deficit + 0.3 GB confirmed)", e.Allowance())
	}
}
