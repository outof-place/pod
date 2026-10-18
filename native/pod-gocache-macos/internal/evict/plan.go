package evict

import (
	"bytes"
	"slices"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
)

// Candidate is a unit with its age in awake time (sleep and forward clock
// jumps after its last use are not counted).
type Candidate struct {
	index.Unit
	Age time.Duration
	// Pinned: a live go process was handed the unit's output (S9). A pinned
	// unit is picked only in the emergency stage, after every unpinned one.
	Pinned bool
}

// Policy orders candidates; Less(a, b) means a is evicted before b. It must
// be a strict total order so plans are deterministic.
type Policy interface {
	Name() string
	Less(a, b *Candidate, window time.Duration) bool
}

// AgeBuckets evicts the oldest idle bucket first and, within a bucket, the
// largest entry first (age predicts reuse; size frees the most per unlink).
type AgeBuckets struct{}

func (AgeBuckets) Name() string { return "age-buckets-v2" }

// ageBounds are the bucket bounds besides the window: Go's own trim age (5 d
// 1 h), 1 d, 6 h, then the steps the relaxed tiers use.
var ageBounds = [...]time.Duration{5*24*time.Hour + time.Hour, 24 * time.Hour, 6 * time.Hour, time.Hour, 30 * time.Minute, 15 * time.Minute}

// ageBucket counts the bounds at or above age; the window is always a bound,
// so no bucket mixes entries inside and outside it.
func ageBucket(age, window time.Duration) int {
	n := 0
	if window >= age {
		n++
	}
	for _, b := range ageBounds {
		if b >= age {
			n++
		}
	}
	return n
}

func (AgeBuckets) Less(a, b *Candidate, window time.Duration) bool {
	if ba, bb := ageBucket(a.Age, window), ageBucket(b.Age, window); ba != bb {
		return ba < bb
	}
	if sa, sb := a.ABytes+a.DBytes, b.ABytes+b.DBytes; sa != sb {
		return sa > sb
	}
	if a.Age != b.Age {
		return a.Age > b.Age
	}
	if a.Orphan != b.Orphan {
		return a.Orphan
	}
	return bytes.Compare(a.ID[:], b.ID[:]) < 0
}

// Sort orders candidates in place by p.
func Sort(c []Candidate, p Policy, window time.Duration) {
	slices.SortFunc(c, func(a, b Candidate) int {
		if p.Less(&a, &b, window) {
			return -1
		}
		if p.Less(&b, &a, window) {
			return 1
		}
		return 0
	})
}

// Stage is the window a planned unit was chosen under.
type Stage uint8

const (
	StageNormal Stage = iota
	StageHard
	StageEmergency
)

// Windows are the three stage windows in effect.
type Windows struct {
	Normal    time.Duration // the process-aware window
	Hard      time.Duration
	Emergency time.Duration
}

func (w Windows) of(s Stage) time.Duration {
	switch s {
	case StageHard:
		return w.Hard
	case StageEmergency:
		return w.Emergency
	}
	return w.Normal
}

// Planned is a unit chosen for eviction and the window it must still be
// outside of when it is removed.
type Planned struct {
	Candidate
	Stage  Stage
	Window time.Duration
	// GaveWay: picked although pinned, because the emergency need was still
	// unmet after every unpinned candidate.
	GaveWay bool
}

// Plan is what the daemon would evict now, in order.
type Plan struct {
	Units      []Planned
	Bytes      int64
	Capped     bool  // the episode cap stopped the plan short
	Protected  int64 // bytes inside the normal window: why a target can't be reached
	Evictable  int64 // bytes outside the normal window
	Future     int64 // bytes whose timestamps lie in the future
	Stuck      int64 // bytes whose removal was refused
	OldestUsed int64 // the oldest recency among candidates (wall ns), 0 if none
	Pinned     int64 // bytes kept by pins (S9)
	GaveWay    int64 // pinned bytes picked for the emergency need
}

// Assign picks sorted units until every stage's need is met or room (the
// episode cap; < 0 for none) is used up. Bytes picked count toward every
// need, so a unit inside the normal window is picked only for what older
// units leave of a relaxed need. A shared output counts once, by the unit
// that drops its last reference.
func Assign(sorted []Candidate, need Need, w Windows, room int64) Plan {
	var p Plan
	limit := [3]int64{
		StageNormal:    need.Total(),
		StageHard:      need.Emergency + need.Hard,
		StageEmergency: need.Emergency,
	}
	drops := map[index.ID]int32{}
	pick := func(c *Candidate, stage Stage, gaveWay bool) {
		last := c.Orphan
		if !c.Orphan && c.HasOut {
			drops[c.Out]++
			last = c.Refs-drops[c.Out] <= 0
		}
		// An empty file frees no bytes but is still an entry to clean up.
		b := max(c.Bytes(last), 1)
		p.Bytes += b
		if gaveWay {
			p.GaveWay += b
		}
		p.Units = append(p.Units, Planned{Candidate: *c, Stage: stage, Window: w.of(stage), GaveWay: gaveWay})
	}
	pinned := false
	for i := range sorted {
		c := &sorted[i]
		bytesAll := c.ABytes + c.DBytes
		switch {
		case c.FutureAt != 0:
			p.Future += bytesAll
			continue
		case c.Stuck:
			p.Stuck += bytesAll
			continue
		}
		if c.Age > w.Normal {
			p.Evictable += bytesAll
		} else {
			p.Protected += bytesAll
		}
		if p.OldestUsed == 0 || c.Recency < p.OldestUsed {
			p.OldestUsed = c.Recency
		}
		if c.Pinned {
			p.Pinned += bytesAll
			pinned = true
			continue
		}
		if p.Bytes >= limit[StageNormal] {
			continue
		}
		if room >= 0 && p.Bytes >= room {
			p.Capped = true
			continue
		}
		stage, ok := pickStage(c.Age, w, p.Bytes, &limit)
		if !ok {
			continue
		}
		pick(c, stage, false)
	}
	// B1: pins give way in the emergency tier, only for what every unpinned
	// candidate the emergency window allows left of the emergency need.
	for i := range sorted {
		if !pinned || p.Bytes >= limit[StageEmergency] || (room >= 0 && p.Bytes >= room) {
			break
		}
		c := &sorted[i]
		if c.Pinned && c.FutureAt == 0 && !c.Stuck && c.Age > w.Emergency {
			pick(c, StageEmergency, true)
		}
	}
	return p
}

func pickStage(age time.Duration, w Windows, picked int64, limit *[3]int64) (Stage, bool) {
	for _, s := range [...]Stage{StageNormal, StageHard, StageEmergency} {
		if picked < limit[s] && age > w.of(s) {
			return s, true
		}
	}
	return 0, false
}
