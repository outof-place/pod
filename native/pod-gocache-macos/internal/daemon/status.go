package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

func ptr(v int64) *int64 { return &v }

// Phases in state.json's extra.phase.
const (
	PhaseStopped   = "stopped"
	PhaseCrashLoop = "crash-loop"
	PhaseError     = "error"
)

func (c *core) phase() string {
	switch {
	case c.fatal != "":
		return PhaseError
	case !c.idx.RootOK():
		return "waiting-for-cache-dir"
	case !c.idx.Complete():
		return "indexing"
	}
	return "ready"
}

func (c *core) target() *int64 {
	if !c.idx.Complete() || !c.needOK {
		return nil
	}
	return ptr(c.need.Target)
}

func (c *core) ownerFile(now time.Time) ownerstate.Owner {
	return ownerstate.Owner{
		Schema:      ownerstate.Schema,
		Version:     c.cfg.Version,
		PID:         c.pid,
		StartedAt:   c.startWall.Unix(),
		HeartbeatAt: now.Unix(),
		Mode:        c.mode,
		CacheDir:    c.cfg.CacheDir,
		BudgetBytes: c.limits().Budget,
		TargetBytes: c.target(),
	}
}

func (c *core) stateFile() ownerstate.State {
	s := ownerstate.State{
		Version:     c.cfg.Version,
		Mode:        c.mode,
		CacheDir:    c.cfg.CacheDir,
		BudgetBytes: c.limits().Budget,
		TargetBytes: c.target(),
		Evictions:   c.evictions,
		HeartbeatAt: c.wall.Unix(),
	}
	if c.freeOK {
		s.FreeDiskBytes = ptr(c.free)
	}
	cpu, rss := rusage()
	x := ownerstate.Extra{
		PID:            c.pid,
		StartedAt:      c.startWall.Unix(),
		Phase:          c.phase(),
		Error:          c.fatal,
		ModeRequested:  c.modeReq,
		ModeReason:     c.modeReason,
		IndexedBuckets: c.idx.Progress(),
		Tier:           c.tier.String(),
		WindowSeconds:  int64(c.window / time.Second),
		WindowReason:   c.whyWin,
		GraceUntil:     c.graceUntil(),
		Policy:         c.cfg.Policy.Name(),
		TrimError:      c.trimErr,
		UnmanagedBytes: c.idx.UnmanagedBytes(),
		UnmanagedFiles: c.idx.UnmanagedCount(),
		CPUSeconds:     cpu.Seconds(),
		MaxRSSBytes:    rss,
		LastClockJump:  c.lastJumpSecs,
		Restarts:       c.restarts,
		Scan: ownerstate.Scan{
			Lstats: c.idx.Counters.Lstats, Reads: c.idx.Counters.Reads,
			Lists: c.idx.Counters.Lists, Relists: c.idx.Counters.Relists,
		},
	}
	x.TempBytes = c.idx.TempBytes()
	x.RootUnmanagedBytes, x.FuzzBytes, x.RootUnmanagedFiles, _ = c.idx.RootUnmanaged()
	x.VanishedBytes = c.vanished
	if !c.vanishedAt.IsZero() {
		x.VanishedLastAt = c.vanishedAt.Unix()
	}
	x.BootTimeUs = c.boot
	if c.tempSwept.Count > 0 {
		sw := c.tempSwept
		x.TempSwept = &sw
	}
	if !c.lastFullAt.IsZero() {
		x.Scan.LastFullAt = c.lastFullAt.Unix()
	}
	if !c.trimWall.IsZero() {
		x.TrimWrittenAt = c.trimWall.Unix()
	}
	if c.idx.Complete() {
		s.SizeBytes = ptr(c.idx.Size())
		s.Entries = ptr(int64(c.idx.Entries()))
		s.WouldEvictBytes = ptr(c.plan.Bytes)
		if c.plan.OldestUsed != 0 {
			s.OldestRecencyAt = ptr(c.plan.OldestUsed / int64(time.Second))
		}
		x.Actions, x.Outputs = c.idx.Actions(), c.idx.Outputs()
		x.ProtectedBytes, x.EvictableBytes = c.plan.Protected, c.plan.Evictable
		x.FutureBytes, x.StuckBytes = c.plan.Future, c.plan.Stuck
	}
	if c.episode.Active {
		e := &ownerstate.Episode{EvictedBytes: c.episode.Evicted, AllowanceBytes: c.episode.Allowance(), ConfirmedBytes: c.episode.Confirmed, RoomBytes: c.room()}
		if c.episode.Paused(c.mono) && c.episode.PausedUntil != 0 {
			e.PausedUntil = c.wall.Add(c.episode.PausedUntil - c.mono).Unix()
			e.NoEffectBytes, e.NoEffectFreeUp = c.episode.NoEffect.Evicted, c.episode.NoEffect.FreeDelta
		}
		x.Episode = e
	}
	for _, j := range c.jumps.list {
		x.SleepCredits = append(x.SleepCredits, [2]int64{j.Boundary, j.Credit})
	}
	x.LastWallNs, x.LastAwakeNs = c.wall.UnixNano(), int64(c.mono)
	x.Live = c.liveStatus()
	x.Reasons = c.reasons()
	s.Extra = x
	return s
}

// reasons explain, in plain words, why the cache is where it is.
func (c *core) reasons() []string {
	var r []string
	add := func(format string, a ...any) { r = append(r, fmt.Sprintf(format, a...)) }
	switch c.phase() {
	case PhaseError:
		add("daemon stopped: %s", c.fatal)
		return r
	case "waiting-for-cache-dir":
		add("waiting for cache dir %s", c.cfg.CacheDir)
		return r
	case "indexing":
		add("indexing: %d of 256 buckets", c.idx.Progress())
		return r
	}
	if c.mode != ownerstate.ModeOwner {
		add("observe mode, deleting nothing: %s", c.modeReason)
	}
	if c.inGrace() {
		add("start grace until %s: no deletions for %s after start while free disk is unknown or >= %s",
			time.Unix(c.graceUntil(), 0).Format("15:04"), c.limits().Window, gb(c.limits().DiskFloor))
	}
	if c.whyWin != "" {
		add("window %s because %s", c.window.Round(time.Minute), c.whyWin)
	}
	if left := c.need.Total() - c.plan.Bytes; left > 0 && !c.plan.Capped {
		add("cannot keep up: %s more needed, nothing else is outside the %s window (%s used within the %s normal window)",
			gb(left), c.tierWindow().Round(time.Second), gb(c.plan.Protected), c.window.Round(time.Minute))
		if c.plan.Pinned > 0 {
			add("cannot keep up: %s pinned by %d live go processes", gb(c.plan.Pinned), c.live.pinning)
		}
	}
	if c.live.sh != nil && !c.live.open {
		add("shared state with clients off: %s", c.live.reason)
	}
	if c.plan.Capped && c.episode.Active {
		add("low-disk episode cap: evicted %s for disk, allowance %s (the largest deficit to %s free plus %s whose removal showed up as free disk)",
			gb(c.episode.Evicted), gb(c.episode.Allowance()), gb(c.limits().DiskFloor), gb(c.episode.Confirmed))
	}
	if c.episode.Paused(c.mono) && c.episode.PausedUntil != 0 {
		add("evicted %s, free disk %s: eviction for disk paused until free disk responds or 10 minutes pass", gb(c.episode.NoEffect.Evicted), signedGB(c.episode.NoEffect.FreeDelta))
	}
	if c.tier >= evict.Hard {
		add("%s: free disk %s, relaxed window and full speed", c.tier, gb(c.free))
	}
	if c.plan.Stuck > 0 {
		add("%s undeletable (permissions or flags)", gb(c.plan.Stuck))
	}
	if c.plan.Future > 0 {
		add("%s with timestamps in the future", gb(c.plan.Future))
	}
	if root, fuzz, _, _ := c.idx.RootUnmanaged(); root+c.idx.UnmanagedBytes()+c.idx.TempBytes() > 0 {
		add("du shows about %s: %s in managed entries (the budget counts only these) plus %s never touched: fuzz/ %s, other files at the root %s, odd names in buckets %s, client temp files %s",
			gb(c.idx.Size()+root+c.idx.UnmanagedBytes()+c.idx.TempBytes()), gb(c.idx.Size()), gb(root+c.idx.UnmanagedBytes()+c.idx.TempBytes()),
			gb(fuzz), gb(root-fuzz), gb(c.idx.UnmanagedBytes()), gb(c.idx.TempBytes()))
	}
	if c.vanished > 0 {
		add("%s deleted by something else since start, last at %s (go clean, Go's own trim, an old trimmer); in owner mode growth here means a trimmer did not stand down",
			gb(c.vanished), c.vanishedAt.Format("15:04"))
	}
	if c.mode == ownerstate.ModeOwner && c.trimErr != "" {
		add("Go trim not suppressed: %s", c.trimErr)
	}
	if !c.freeOK {
		add("free disk unknown: keeping to the budget only")
	}
	return r
}

func (c *core) writeStatus() {
	c.stateAt, c.wroteOnce, c.changed = c.mono, true, false
	c.writeOwner(c.ownerFile(c.wall), c.mono)
	if err := c.cfg.Sink.WriteState(c.stateFile()); err != nil {
		c.log.Once("state-write", "state.json not written: %v", err)
	}
}

// writeOwner writes owner.json at normal priority, so the heartbeat never
// queues behind throttled scanning.
func (c *core) writeOwner(o ownerstate.Owner, mono time.Duration) {
	c.ownerAt = mono
	if c.bg {
		c.cfg.Prio.Background(false)
		defer c.cfg.Prio.Background(true)
	}
	if err := c.cfg.Sink.WriteOwner(o); err != nil {
		c.log.Once("owner-write", "owner.json not written: %v", err)
	}
}

// Status is what `pod-gocache status --json` prints: state.json plus whether
// the heartbeat is fresh. With no state.json, NeverRan is true.
type Status struct {
	ownerstate.State
	HeartbeatFresh bool `json:"heartbeatFresh"`
	Stale          bool `json:"stale"` // state.json exists but no daemon keeps it fresh
	NeverRan       bool `json:"neverRan,omitempty"`
}

// ReadStatus reads the state directory; it works with the daemon down. A
// daemon that stopped, tripped the crash-loop breaker or failed to start is
// stale whatever its last heartbeat says.
func ReadStatus(stateDir string, now time.Time) (Status, error) {
	s, ok, err := ownerstate.ReadState(stateDir)
	if err != nil {
		return Status{}, err
	}
	if !ok {
		return Status{NeverRan: true}, nil
	}
	hb := s.HeartbeatAt
	if o, ok, err := ownerstate.ReadOwner(stateDir); err == nil && ok {
		hb = o.HeartbeatAt
	}
	fresh := ownerstate.Fresh(hb, now)
	switch s.Extra.Phase {
	case PhaseStopped, PhaseCrashLoop, PhaseError:
		fresh = false
	}
	return Status{State: s, HeartbeatFresh: fresh, Stale: !fresh}, nil
}

// PrintStatus writes the status as JSON or as a few lines of text.
func PrintStatus(w io.Writer, st Status, asJSON bool) {
	if asJSON && st.NeverRan {
		// The frozen pair (version, mode) plus the marker; no zero numbers.
		data, _ := json.Marshal(struct {
			Version        string `json:"version"`
			Mode           string `json:"mode"`
			NeverRan       bool   `json:"neverRan"`
			HeartbeatFresh bool   `json:"heartbeatFresh"`
			Stale          bool   `json:"stale"`
		}{st.Version, st.Mode, true, false, false})
		fmt.Fprintf(w, "%s\n", data)
		return
	}
	if asJSON {
		data, _ := json.MarshalIndent(st, "", "  ")
		fmt.Fprintf(w, "%s\n", data)
		return
	}
	if st.NeverRan {
		fmt.Fprintf(w, "pod-gocache %s: standalone (the daemon never ran: no state.json)\n", st.Version)
		return
	}
	run := "running"
	if !st.HeartbeatFresh {
		run = "not running (stale status)"
	}
	fmt.Fprintf(w, "pod-gocache daemon %s: %s, mode %s, %s\n", st.Version, run, st.Mode, st.CacheDir)
	if st.SizeBytes != nil {
		fmt.Fprintf(w, "cache %s in %d entries, target %s, budget %s\n", gb(*st.SizeBytes), *st.Entries, gb(deref(st.TargetBytes)), gb(st.BudgetBytes))
	}
	if st.FreeDiskBytes != nil {
		fmt.Fprintf(w, "free disk %s, tier %s, window %s\n", gb(*st.FreeDiskBytes), st.Extra.Tier, time.Duration(st.Extra.WindowSeconds)*time.Second)
	}
	fmt.Fprintf(w, "evicted %d files, %s\n", st.Evictions.Count, gb(st.Evictions.Bytes))
	for _, r := range st.Extra.Reasons {
		fmt.Fprintf(w, "- %s\n", r)
	}
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func (c *core) liveStatus() *ownerstate.Live {
	l := c.live
	if l.sh == nil {
		return nil
	}
	st := &ownerstate.Live{Reason: l.reason, Kept: l.skipped, Records: l.records, Rereads: l.rereads, Handshake: l.batches}
	if !l.open {
		return st
	}
	st.Dir = l.sh.Where()
	st.Entries, st.Slots, st.Refused = l.sh.IndexStats()
	st.Clients, st.Pinning, st.Overflow = l.clients, l.pinning, l.overflowed
	st.Pinned, st.OverCap, st.GaveWay = l.pinnedBytes, l.overCap, c.plan.GaveWay
	return st
}
