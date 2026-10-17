// Package evict decides what the daemon may delete: disk tiers with
// hysteresis, the safety windows, how many bytes each tier needs back, the
// eviction order, and the per-episode cap. It is pure: no I/O, no clocks.
package evict

import "time"

// GB is a decimal gigabyte, as Finder and df -H count.
const GB int64 = 1_000_000_000

// Limits are the daemon's fixed numbers; tests scale them.
type Limits struct {
	Budget         int64 // cache target with plenty of disk
	DiskFloor      int64 // below this much free disk, shrink the cache toward it
	CacheFloor     int64 // never shrink below this for disk outside the relaxed tiers
	HardFloor      int64 // below this, the relaxed 30 min window and full speed
	EmergencyFloor int64 // below this, the relaxed 15 min window
	Hysteresis     int64 // a tier is left only this far above its threshold

	Window          time.Duration // T: never delete within this of an entry's last use
	HardWindow      time.Duration
	EmergencyWindow time.Duration
	ProcessMargin   time.Duration // added to the oldest live go process's age
	ProcessAgeCap   time.Duration // a live go process counts as at most this old
	GoRunCap        time.Duration // a go run or go tool process counts as at most this old
	ExitGrace       time.Duration // a go process still counts this long after it exits
}

// Defaults are the production limits.
func Defaults() Limits {
	return Limits{
		Budget:          30 * GB,
		DiskFloor:       15 * GB,
		CacheFloor:      15 * GB,
		HardFloor:       10 * GB,
		EmergencyFloor:  7 * GB,
		Hysteresis:      1 * GB,
		Window:          2 * time.Hour,
		HardWindow:      30 * time.Minute,
		EmergencyWindow: 15 * time.Minute,
		ProcessMargin:   65 * time.Minute,
		ProcessAgeCap:   6 * time.Hour,
		GoRunCap:        30 * time.Minute,
		ExitGrace:       45 * time.Minute,
	}
}

// Tier is how short of disk the machine is.
type Tier uint8

const (
	Normal    Tier = iota // free >= DiskFloor
	Low                   // below DiskFloor: shrink toward it with the normal window
	Hard                  // below HardFloor: relaxed 30 min window, full speed
	Emergency             // below EmergencyFloor: relaxed 15 min window, full speed
)

func (t Tier) String() string {
	return [...]string{"normal", "low-disk", "hard-floor", "emergency"}[t]
}

// NextTier enters a tier at its threshold and leaves it only at threshold +
// Hysteresis, so free disk oscillating around a threshold doesn't flap.
func NextTier(prev Tier, free int64, l Limits) Tier {
	thresholds := [...]int64{Low: l.DiskFloor, Hard: l.HardFloor, Emergency: l.EmergencyFloor}
	t := Normal
	for tier := Low; tier <= Emergency; tier++ {
		th := thresholds[tier]
		if free < th || (prev >= tier && free < th+l.Hysteresis) {
			t = tier
		}
	}
	return t
}

// FullSpeed reports whether eviction runs unthrottled.
func (t Tier) FullSpeed() bool { return t >= Hard }

// ProcessWindow is the normal window widened by the oldest live go process:
// max(Window, min(age, ProcessAgeCap) + ProcessMargin). age < 0 means none.
// The cap bounds the process age, not the window, so a 6 h build still keeps
// lookups Go's hourly refresh skipped, and a hung one can't freeze eviction.
func ProcessWindow(l Limits, oldestAge time.Duration) time.Duration {
	w := l.Window
	if oldestAge >= 0 {
		w = max(w, min(oldestAge, l.ProcessAgeCap)+l.ProcessMargin)
	}
	return w
}

// Need is how many bytes each stage must give back, and the cache size the
// daemon is steering toward.
type Need struct {
	Emergency int64 // freed with EmergencyWindow, until free disk is back at EmergencyFloor + Hysteresis
	Hard      int64 // freed with HardWindow, until HardFloor + Hysteresis
	Normal    int64 // freed with the process-aware window
	Target    int64
}

// Total is every byte the stages need.
func (n Need) Total() int64 { return n.Emergency + n.Hard + n.Normal }

// Needs computes the stage needs for a cache of size bytes with free bytes of
// disk in tier.
func Needs(size, free int64, tier Tier, l Limits) Need {
	var n Need
	if tier == Emergency {
		n.Emergency = max(0, l.EmergencyFloor+l.Hysteresis-free)
	}
	if tier >= Hard {
		n.Hard = max(0, l.HardFloor+l.Hysteresis-free-n.Emergency)
	}
	relaxed := n.Emergency + n.Hard
	rest := max(0, size-relaxed)
	target := l.Budget
	if free < l.DiskFloor {
		deficit := max(0, l.DiskFloor-free-relaxed)
		target = min(l.Budget, max(l.CacheFloor, rest-deficit))
	}
	n.Normal = max(0, rest-target)
	n.Target = min(target, rest)
	if n.Total() == 0 {
		n.Target = target
	}
	return n
}
