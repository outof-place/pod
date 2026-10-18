// Package cachesim is a deterministic simulated machine for testing the
// daemon: a GOCACHE directory, go processes that follow cmd/go's cache rules
// (markUsed's hourly refresh, put order, shared outputs, executables), a
// process table, a disk, and wall and awake clocks that part on sleep. Every
// daemon filesystem call costs simulated time, so go steps interleave with
// it. The world checks the safety invariants on every removal.
package cachesim

import (
	"container/heap"
	"fmt"
	"math/rand"
	"time"
)

// Removal is one entry the daemon removed, with the ground truth at that
// instant.
type Removal struct {
	Rel       string
	Mono      time.Duration
	AwakeAge  time.Duration // since the file's last use, in awake time
	Bytes     int64
	FreeAtCut int64 // the daemon's last free-disk sample
	Live      int   // go processes alive at that instant
}

// Failure is a go process that found a file it had looked up missing.
type Failure struct {
	Rel      string
	Kind     string
	Life     time.Duration
	HeldFor  time.Duration // since the lookup
	Class    string        // "concurrent-put" for the documented residual race
	At       time.Duration
	Proc     int32
	Detail   string
	Removed  bool // the daemon removed it (vs. something else)
	Acquired time.Duration
	Client   bool // the process ran through the GOCACHEPROG client
}

// Limits mirror the daemon's, for the independent checks.
type Limits struct {
	Window, HardWindow, EmergencyWindow    time.Duration
	ProcessMargin, ProcessAgeCap, GoRunCap time.Duration
	Budget                                 int64
	DiskFloor, HardFloor, EmergencyFloor   int64
	Hysteresis                             int64
	ProcLag                                time.Duration // the daemon's process-table refresh period
}

// World is the simulated machine.
type World struct {
	rng    *rand.Rand
	mono   time.Duration
	offset int64 // wall ns = mono + offset

	fs     fsState
	disk   diskState
	procs  map[int32]*Proc
	pidSeq int32
	events eventHeap
	evSeq  uint64

	// Daemon-facing state.
	OpCost        time.Duration
	ModeNow       string
	ModeValid     bool
	modeKeySeq    uint64
	modeChangedAt time.Duration
	tickStart     time.Duration
	daemonStart   time.Duration
	lastStateBoot int64 // kern.boottime in the last state.json written or restored
	graceSkipped  bool
	freeSamples   [2]int64
	lastProcList  []ProcSnap
	lastProcWall  int64

	L Limits
	// BootUs is the simulated kern.boottime (unix microseconds).
	BootUs int64

	// Results.
	Violations []string
	Failures   []Failure
	Removals   []Removal
	Mutations  int // removals, retimes, arms and trim writes
	// RefusedTries counts removals refused by permissions or flags.
	RefusedTries int
	// ConcurrentRefs counts outputs removed while an -a written during the
	// same daemon tick referenced them (the documented put race).
	ConcurrentRefs int
	TrimWrites     []time.Duration
	Owners         []OwnerBeat
	BG             []bool
	OpsByTick      int
	// D4Episodes counts low-disk episodes the D4 check followed; D4Excess is
	// the most any of them evicted for disk beyond its largest deficit.
	D4Episodes int
	D4Excess   int64
	d4         d4State
	d4Outs     map[[32]byte]d4Pend
	tempUsed   int64

	removedAt map[string]time.Duration
	// Journal records sleeps, clock steps and notes, for failure reports.
	Journal  []string
	workload *Workload

	// S9: the shared-state model and what client processes did with it.
	shared                         *Shared
	FastHits, DiskHits, GoneMisses int
	DyingMisses, DyingPuts         int
	PinnedRemovals                 []Removal // outputs removed while a live client pinned them
	PinExpiry                      time.Duration
}

// OwnerBeat is one owner.json write; Background marks one made while the
// daemon's thread was in the background band.
type OwnerBeat struct {
	Mono        time.Duration
	HeartbeatAt int64
	Mode        string
	Background  bool
}

// New returns an empty world whose clocks start at wall start.
func New(seed int64, start time.Time, l Limits) *World {
	w := &World{
		rng:       rand.New(rand.NewSource(seed)),
		mono:      time.Hour,
		procs:     map[int32]*Proc{},
		OpCost:    20 * time.Microsecond,
		ModeNow:   "observe",
		ModeValid: true,
		L:         l,
		removedAt: map[string]time.Duration{},
		pidSeq:    1000,
	}
	w.offset = start.UnixNano() - int64(w.mono)
	w.BootUs = w.offset / 1000
	w.fs.init(w)
	w.disk.capacity = 500 * 1_000_000_000
	return w
}

// Rand is the world's deterministic source.
func (w *World) Rand() *rand.Rand { return w.rng }

// WallNs is wall time in unix ns.
func (w *World) WallNs() int64 { return int64(w.mono) + w.offset }

// Now is awake (monotonic) time.
func (w *World) Now() time.Duration { return w.mono }

// Wall implements the daemon's Clock.
func (w *World) Wall() time.Time { return time.Unix(0, w.WallNs()) }

// Mono implements the daemon's Clock.
func (w *World) Mono() time.Duration { return w.mono }

// Boot implements the daemon's Clock.
func (w *World) Boot() int64 { return w.BootUs }

// Sleep moves wall time forward by d with no awake time passing (lid closed).
func (w *World) Sleep(d time.Duration) {
	w.offset += int64(d)
	w.Journal = append(w.Journal, fmt.Sprintf("t=%s wall=%s sleep %s", w.mono-time.Hour, w.Wall().UTC().Format(time.TimeOnly), d))
}

// Stall moves awake and wall time forward by d inside an event, as a daemon
// stopped (SIGSTOP) or starved for d between two instructions sees it; events
// due meanwhile run when the event returns.
func (w *World) Stall(d time.Duration) {
	w.mono += d
	w.Journal = append(w.Journal, fmt.Sprintf("t=%s stall %s", w.mono-time.Hour, d))
}

// StepClock sets the wall clock by d (either direction) without sleeping.
func (w *World) StepClock(d time.Duration) {
	w.offset += int64(d)
	w.Journal = append(w.Journal, fmt.Sprintf("t=%s wall=%s clock step %s", w.mono-time.Hour, w.Wall().UTC().Format(time.TimeOnly), d))
}

// Note adds a line to the journal.
func (w *World) Note(format string, a ...any) {
	w.Journal = append(w.Journal, fmt.Sprintf("t=%s wall=%s ", w.mono-time.Hour, w.Wall().UTC().Format(time.TimeOnly))+fmt.Sprintf(format, a...))
}

func (w *World) violate(format string, a ...any) {
	if len(w.Violations) < 50 {
		w.Violations = append(w.Violations, fmt.Sprintf("t=%s ", w.mono-time.Hour)+fmt.Sprintf(format, a...))
	}
}

// --- events ---

type event struct {
	at  time.Duration
	seq uint64
	fn  func()
}

type eventHeap []event

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].at != h[j].at {
		return h[i].at < h[j].at
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(event)) }
func (h *eventHeap) Pop() any {
	old := *h
	e := old[len(old)-1]
	*h = old[:len(old)-1]
	return e
}

// At schedules fn at awake time t.
func (w *World) At(t time.Duration, fn func()) {
	if t < w.mono {
		t = w.mono
	}
	w.evSeq++
	heap.Push(&w.events, event{at: t, seq: w.evSeq, fn: fn})
}

// After schedules fn d from now.
func (w *World) After(d time.Duration, fn func()) { w.At(w.mono+d, fn) }

// advance runs every event due up to t and moves the clock there.
func (w *World) advance(t time.Duration) {
	for len(w.events) > 0 && w.events[0].at <= t {
		e := heap.Pop(&w.events).(event)
		if e.at > w.mono {
			w.mono = e.at
		}
		e.fn()
	}
	if t > w.mono {
		w.mono = t
	}
}

// op is called before every daemon filesystem call: the call costs OpCost
// and go processes run in the meantime.
func (w *World) op() {
	w.OpsByTick++
	w.advance(w.mono + w.OpCost)
}

// Run drives the world until awake time until, calling tick whenever the
// daemon is due; tick returns the delay to its next call.
func (w *World) Run(until time.Duration, tick func() time.Duration) {
	next := w.mono
	for w.mono < until {
		if next > until {
			w.advance(until)
			return
		}
		w.advance(next)
		w.tickStart, w.OpsByTick = w.mono, 0
		d := tick()
		if d <= 0 {
			d = time.Millisecond
		}
		next = w.mono + d
	}
}

// DaemonStarted records a (re)start, for the start-grace check; a new daemon
// starts a new low-disk episode too. After a reboot since the state.json it
// finds (no go process survives one) there is no grace to check.
func (w *World) DaemonStarted() {
	w.daemonStart, w.d4, w.d4Outs = w.mono, d4State{}, nil
	d := w.lastStateBoot - w.BootUs
	w.graceSkipped = w.lastStateBoot != 0 && (d > int64(time.Minute/time.Microsecond) || -d > int64(time.Minute/time.Microsecond))
}

// SetMode changes what the mode file says.
func (w *World) SetMode(m string, valid bool) {
	w.ModeNow, w.ModeValid = m, valid
	w.modeKeySeq++
	w.modeChangedAt = w.mono
}
