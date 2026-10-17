package evict

import "time"

// Episode caps eviction for disk while free disk is below DiskFloor (D4).
type Episode struct {
	Active bool
	tier   Tier
	lifted uint8 // tiers whose drop already lifted a no-effect pause
	// allowance = max(allowance, live deficit + Confirmed): eviction that frees
	// no disk stays within the largest deficit seen, and eviction that does
	// keeps up with whatever else eats the disk.
	allowance int64
	Confirmed int64 // evicted bytes in chunks that showed up as free disk
	Evicted   int64

	chunkEvicted int64
	chunkFree    int64 // free disk and cache growth just before the chunk's first removal
	chunkAdded   int64
	lastEvict    time.Duration // monotonic
	settleAt     time.Duration // monotonic; zero when not settling

	PausedUntil time.Duration // monotonic; zero when not paused
	pausedFree  int64
	pausedChunk int64
	// NoEffect describes the last chunk that freed nothing, for status and the log.
	NoEffect struct{ Evicted, FreeDelta int64 }
}

// Detector constants (amendment 3, D4).
const (
	noEffectChunk  = 2 * GB
	noEffectSettle = 5 * time.Second
	noEffectPause  = 10 * time.Minute
)

// Observation is what Observe learned about the last chunk.
type Observation uint8

const (
	Nothing         Observation = iota
	Confirmed                   // the chunk showed up as free disk
	NoEffectPaused              // a full chunk freed under 10%: paused
	NoEffectPartial             // a smaller chunk freed under half: not counted
)

// Update follows the tier and live free disk; it returns whether an episode
// starts, escalates or ends now, for logging.
func (e *Episode) Update(tier Tier, free int64, l Limits) (changed bool) {
	switch {
	case tier == Normal:
		if !e.Active {
			return false
		}
		*e = Episode{}
		return true
	case !e.Active:
		*e = Episode{Active: true, tier: tier}
		changed = true
	case tier > e.tier:
		// Falling a tier means something else writes: that lifts a pause, but
		// only once per tier, so free disk swinging across a line can't.
		if e.PausedUntil != 0 && e.lifted&(1<<tier) == 0 {
			e.lifted |= 1 << tier
			e.PausedUntil = 0
		}
		e.spoilChunk()
		e.tier, changed = tier, true
	case tier < e.tier:
		e.spoilChunk()
		e.tier = tier
	}
	e.allowance = max(e.allowance, max(0, l.DiskFloor-free)+e.Confirmed)
	return changed
}

// Allowance is the episode's cap on eviction for disk.
func (e *Episode) Allowance() int64 { return e.allowance }

// Room is how many more bytes the episode allows; -1 when no episode runs.
// A unit is started while Room > 0, so the cap can be passed by one entry.
func (e *Episode) Room() int64 {
	if !e.Active {
		return -1
	}
	return max(0, e.allowance-e.Evicted)
}

// Paused reports whether eviction for disk waits, either settling to measure
// the effect of a full chunk or after one that freed nothing.
func (e *Episode) Paused(mono time.Duration) bool {
	return e.Active && (e.settleAt != 0 || (e.PausedUntil != 0 && mono < e.PausedUntil))
}

// Evict records n bytes removed for disk; free and added are the tick's free
// disk sample (taken before this tick's removals) and the cache growth so far.
func (e *Episode) Evict(n, free, added int64, mono time.Duration) {
	if !e.Active || n <= 0 {
		return
	}
	if e.chunkEvicted == 0 {
		e.chunkFree, e.chunkAdded = free, added
	}
	e.Evicted += n
	e.chunkEvicted += n
	e.lastEvict = mono
	if e.chunkEvicted >= noEffectChunk && e.settleAt == 0 {
		e.settleAt = mono + noEffectSettle
	}
}

// Observe judges the current chunk once it settled: a full chunk after the
// settle, a smaller one after eviction stopped for the settle time (busy:
// removals still queued). It also resumes a pause when free disk responds.
func (e *Episode) Observe(free, added int64, mono time.Duration, busy bool) Observation {
	if !e.Active {
		return Nothing
	}
	if e.PausedUntil != 0 {
		if free-e.pausedFree >= e.pausedChunk/10 || mono >= e.PausedUntil {
			e.PausedUntil = 0
		}
		return Nothing
	}
	full := e.settleAt != 0
	if full && mono < e.settleAt {
		return Nothing
	}
	if !full && (e.chunkEvicted == 0 || busy || mono-e.lastEvict < noEffectSettle) {
		return Nothing
	}
	chunk := e.chunkEvicted
	// What go added to the cache meanwhile explains a smaller rise.
	effect := (free - e.chunkFree) + (added - e.chunkAdded)
	delta := free - e.chunkFree
	e.settleAt = 0
	e.resetChunk()
	switch {
	case effect*2 >= chunk:
		e.Confirmed += chunk
		return Confirmed
	case full && effect*10 < chunk:
		e.NoEffect.Evicted, e.NoEffect.FreeDelta = chunk, delta
		e.PausedUntil, e.pausedFree, e.pausedChunk = mono+noEffectPause, free, chunk
		return NoEffectPaused
	case !full:
		e.NoEffect.Evicted, e.NoEffect.FreeDelta = chunk, delta
		return NoEffectPartial
	}
	return Nothing
}

// spoilChunk drops the chunk being measured when free disk crosses a tier
// line: someone else freeing disk then could pass for the chunk's effect.
func (e *Episode) spoilChunk() {
	e.settleAt = 0
	e.resetChunk()
}

func (e *Episode) resetChunk() {
	e.chunkEvicted, e.chunkFree, e.chunkAdded = 0, 0, 0
}
