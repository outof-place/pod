package daemon

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/procscan"
)

// core is the daemon's state machine. tick does one bounded round of work;
// tests drive it directly with simulated clocks, disk and filesystem.
type core struct {
	cfg  Config
	log  *Logger
	fs   cachefs.FS // cfg.FS, pulsing the heartbeat on every call
	idx  *index.Index
	live *live // state shared with clients (S9)
	pid  int
	bg   bool // the loop's thread is in the background band now
	// lagging says why the loop works outside the background band ("" when
	// it keeps up): at load 60-130 a background thread indexed nothing for
	// minutes and missed its eviction slots.
	lagging     string
	indexTicks  int  // ticks spent on the initial index so far
	evictBehind bool // the last batch left planned work undone

	startWall time.Time
	startMono time.Duration
	wall      time.Time // this tick's clocks
	mono      time.Duration
	jumps     jumps
	jumped    bool // a jump this tick: rewrite heartbeat and trim.txt now

	free    int64
	freeOK  bool
	tier    evict.Tier
	episode evict.Episode

	mode       string // effective: observe or owner
	modeReq    string
	modeReason string
	modeKey    ownerstate.ModeKey
	modeReadAt time.Duration
	modeValid  bool
	pendingBad ownerstate.ModeKey // an invalid mode file version awaiting confirmation
	pendingAt  time.Duration
	lockHeld   bool
	lockFree   func()
	lockTryAt  time.Duration
	changed    bool // something status-worthy changed: write status now

	scanUntil  time.Duration // this tick's scan budget ends
	relistAt   time.Duration
	restatAt   time.Duration
	rootWalkAt time.Duration
	rootGen    uint32
	procAt     time.Duration
	window     time.Duration // the process-aware normal window
	whyWin     string
	planAt     time.Duration
	planWin    time.Duration
	sorted     []evict.Candidate
	pinMarked  uint64 // live.version+1 when sorted was last marked (0: never)
	plan       evict.Plan
	need       evict.Need
	needOK     bool // need computed from a complete index
	units      []index.Unit

	pending      map[index.ID]pendingOut // outputs whose last -a the daemon removed
	pendingBytes int64                   // their bytes: committed, not yet freed

	ownerAt     time.Duration // last owner.json write
	stateAt     time.Duration // last state.json write
	wroteOnce   bool
	trimAt      time.Duration
	trimWall    time.Time
	trimErr     string
	trimRetryAt time.Duration
	trimBusyAt  time.Duration // first of consecutive attempts that found trim.txt locked
	trimBusy    bool

	procs     procscan.Tracker
	livePids  map[int32]bool
	procsOK   bool
	temps     []index.Temp
	tempSwept ownerstate.Evictions

	evictions     ownerstate.Evictions
	vanished      int64 // index.Vanished last seen
	vanishedAt    time.Time
	boot          int64     // kern.boottime, unix us
	noGrace       bool      // rebooted since the last state.json: no start grace
	handover      *handover // the clean stop this start took over from; nil for none
	refusedLogged map[string]bool
	futureLogged  map[string]bool
	lastFullAt    time.Time
	lastSummary   time.Duration
	lastJumpSecs  int64
	fatal         string          // a startup error shown in state.json
	behind        bool            // low disk and the plan cannot cover the need
	restarts      int             // unclean starts within the crash window, before this one
	stop          <-chan struct{} // closed on SIGTERM: long work ends early so shutdown runs within ExitTimeOut
}

type pendingOut struct {
	since   time.Duration
	window  time.Duration
	stage   evict.Stage
	bytes   int64
	gaveWay bool // planned although pinned (emergency give-way)
}

func newCore(cfg Config, log *Logger) *core {
	c := &core{
		cfg:           cfg,
		log:           log,
		pid:           os.Getpid(),
		mode:          ownerstate.ModeObserve,
		modeReq:       ownerstate.ModeObserve,
		pending:       map[index.ID]pendingOut{},
		refusedLogged: map[string]bool{},
		futureLogged:  map[string]bool{},
		window:        cfg.Limits.Window,
		procs:         procscan.Tracker{Grace: cfg.Limits.ExitGrace},
	}
	c.fs = pacedFS{FS: cfg.FS, pulse: c.pulse}
	c.idx = index.New(c.fs)
	c.live = newLive(cfg.Shared, cfg.PinExpiry, cfg.PinCap)
	if f, ok := cfg.Shared.(*fileShared); ok && f.logf == nil {
		f.logf = log.Printf
	}
	c.startWall, c.startMono = cfg.Clock.Wall(), cfg.Clock.Mono()
	c.wall, c.mono = c.startWall, c.startMono
	c.boot = cfg.Clock.Boot()
	c.jumps.observe(c.startWall.UnixNano(), c.startMono, cfg.JumpTolerance)
	// Sleeps seen by the previous run, or missed while none ran, still count;
	// after a reboot none do, since no go process survives one.
	prev, hadPrev := cfg.Sink.Previous()
	// No go process survives a reboot, so the start grace (time for builds the
	// daemon cannot see to show their use) has nothing to protect.
	if hadPrev && rebooted(prev.Extra.BootTimeUs, c.boot) {
		c.noGrace = true
		log.Printf("reboot since the last run: no start grace")
	}
	if h, ok := findHandover(prev, cfg.CacheDir, c.boot, c.startWall, cfg.Limits); hadPrev && ok {
		c.handover = &h
		c.window = max(c.window, h.window)
		log.Printf("handover from pid %d version %s (clean stop %s before this start): start grace left %s, the stopped run's; window at least %s, the stopped run's, for %s",
			h.pid, h.version, h.gap.Round(time.Second), h.graceLeft.Round(time.Second), h.window, cfg.Limits.ExitGrace)
	}
	if hadPrev && prev.CacheDir == cfg.CacheDir {
		if rebooted(prev.Extra.BootTimeUs, c.boot) {
			log.Printf("reboot since the last run: no sleep credit carried over")
		} else {
			for _, j := range prev.Extra.SleepCredits {
				c.jumps.list = append(c.jumps.list, jump{Boundary: j[0], Credit: j[1]})
			}
			if d := c.jumps.resume(prev.Extra.LastWallNs, time.Duration(prev.Extra.LastAwakeNs), c.startWall.UnixNano(), c.startMono, cfg.JumpTolerance); d != 0 {
				c.lastJumpSecs = d / int64(time.Second)
				log.Printf("clock-jump seconds=%d while no daemon ran: credited to every entry used before now", c.lastJumpSecs)
			}
			c.jumps.prune(c.startWall.UnixNano(), 6*24*time.Hour)
		}
	}
	c.ownerAt, c.stateAt = -1<<62, -1<<62
	c.rootWalkAt = -1 << 62
	return c
}

// pacedFS calls pulse before every call into the cache directory, so a long
// scan or batch keeps owner.json fresh for as long as it makes progress.
type pacedFS struct {
	cachefs.FS
	pulse func()
}

func (p pacedFS) Lstat(rel string) (cachefs.Stat, error) { p.pulse(); return p.FS.Lstat(rel) }
func (p pacedFS) ReadDirNames(rel string) ([]string, error) {
	p.pulse()
	return p.FS.ReadDirNames(rel)
}
func (p pacedFS) ReadPrefix(rel string, buf []byte) (int, error) {
	p.pulse()
	return p.FS.ReadPrefix(rel, buf)
}
func (p pacedFS) RemoveIfIdle(rel string, ino uint64, cutoff int64) (cachefs.Outcome, cachefs.Stat, error) {
	p.pulse()
	return p.FS.RemoveIfIdle(rel, ino, cutoff)
}
func (p pacedFS) RemoveEmptyDir(rel string, cutoff int64) (cachefs.Outcome, error) {
	p.pulse()
	return p.FS.RemoveEmptyDir(rel, cutoff)
}
func (p pacedFS) SetTimes(rel string, ns int64) error { p.pulse(); return p.FS.SetTimes(rel, ns) }
func (p pacedFS) Arm(rel string, atime int64) error   { p.pulse(); return p.FS.Arm(rel, atime) }
func (p pacedFS) RemoveTemp(rel string, ino uint64, cutoff int64) (cachefs.Outcome, cachefs.Stat, error) {
	p.pulse()
	return p.FS.RemoveTemp(rel, ino, cutoff)
}
func (p pacedFS) WriteTrim(data []byte) error { p.pulse(); return p.FS.WriteTrim(data) }

// pulse writes owner.json when it is due, from inside long work.
func (c *core) pulse() {
	if c.wroteOnce && c.cfg.Clock.Mono()-c.ownerAt >= c.cfg.HeartbeatEvery {
		c.writeOwner(c.ownerFile(c.cfg.Clock.Wall()), c.cfg.Clock.Mono())
	}
}

// prio moves the loop's thread in or out of the background band; a loop
// that fell behind stays out.
func (c *core) prio(bg bool) {
	bg = bg && c.lagging == ""
	c.bg = bg
	c.cfg.Prio.Background(bg)
}

// lagIndexTicks is how many ticks the initial index may take in the
// background band (about 30 s at the default tick).
var lagIndexTicks = 15 // a var so the CPU-loaded rig can measure the band alone

// updateLag decides whether the loop has fallen behind: the initial index
// still incomplete after lagIndexTicks, the last batch cut short with work
// left, or the cache over budget with removals planned. It goes back to the
// background band once none holds.
func (c *core) updateLag() {
	why := ""
	switch {
	case !c.idx.Complete() && c.indexTicks >= lagIndexTicks:
		why = "indexing for " + strconv.Itoa(c.indexTicks) + " ticks"
	case c.mode != ownerstate.ModeOwner || !c.idx.Complete() || c.inGrace() || c.episode.Paused(c.mono):
	case c.evictBehind:
		why = "the last eviction batch left work undone"
	case c.idx.Size() > c.limits().Budget && c.plan.Bytes > 0:
		why = "over budget with " + gb(c.plan.Bytes) + " to remove"
	}
	if (why == "") != (c.lagging == "") {
		if why != "" {
			c.log.Printf("loop behind (%s): out of the background band", why)
		} else {
			c.log.Printf("loop caught up: background band again")
		}
		c.changed = true
	}
	c.lagging = why
}

// scanMore reports whether this tick's scan budget has time left.
func (c *core) scanMore() bool { return c.cfg.Clock.Mono() < c.scanUntil && !c.stopping() }

// stopping reports whether a stop was asked for; a nil stop (the simulations) never is.
func (c *core) stopping() bool {
	select {
	case <-c.stop:
		return true
	default:
		return false
	}
}

func (c *core) limits() evict.Limits { return c.cfg.Limits }

// tick runs one round and returns how long to wait before the next.
func (c *core) tick() time.Duration {
	c.wall, c.mono = c.cfg.Clock.Wall(), c.cfg.Clock.Mono()
	c.scanUntil = c.mono + c.cfg.ScanBudget
	c.observeClock()
	c.sampleDisk()
	c.updateMode()
	if !c.wroteOnce {
		c.idx.CheckRoot()
		c.followRoot()  // the baseline root: a replacement later in this tick still counts
		c.writeStatus() // owner.json within a second of start, before indexing
	}
	full := c.tier.FullSpeed()
	c.updateLag()
	indexed := c.indexWork(full)
	c.followRoot()
	c.liveStep()
	if c.idx.Complete() {
		if c.episode.Update(c.tier, c.free, c.limits()) {
			c.logEpisode()
		}
		c.observeEpisode()
		c.refreshPlan(false)
	}
	more := false
	if c.mode == ownerstate.ModeOwner && c.idx.Complete() && !c.stopping() {
		more = c.execute(full)
		c.evictBehind = more
		c.normalizeFuture()
		c.sweepTemps()
		c.followRoot()
	}
	c.maybeTrim()
	c.maybeSummary()
	if v := c.idx.Vanished; v != c.vanished {
		c.vanished, c.vanishedAt = v, c.wall
	}
	if c.changed || c.jumped || c.mono-c.stateAt >= c.cfg.HeartbeatEvery {
		c.writeStatus()
	}
	if full && (more || indexed) {
		return 0
	}
	if d, ok := c.nextSettle(); ok && full && d > 0 {
		return min(c.cfg.Tick, d)
	}
	return c.cfg.Tick
}

// followRoot notices the cache directory appearing, vanishing or being
// replaced: the index starts over, queued outputs are dropped, and the lock
// on the old directory is let go so updateMode takes one on the new one.
func (c *core) followRoot() {
	g := c.idx.RootGen()
	if g == c.rootGen {
		return
	}
	first := c.rootGen == 0
	c.rootGen = g
	c.lockTryAt = 0 // a directory that appeared or was replaced gets its lock tried on the next tick
	if first {
		return
	}
	c.log.Printf("cache directory replaced or gone: reindexing")
	c.clearPending()
	c.releaseOwner()
	c.needOK, c.changed = false, true
}

func (c *core) observeEpisode() {
	switch c.episode.Observe(c.free, c.idx.Added, c.mono, len(c.pending) > 0) {
	case evict.NoEffectPaused:
		c.log.Printf("no effect: evicted %s, free disk %s; pausing eviction for disk 10m",
			gb(c.episode.NoEffect.Evicted), signedGB(c.episode.NoEffect.FreeDelta))
		c.changed = true
	case evict.NoEffectPartial:
		c.log.Printf("no effect: evicted %s, free disk %s; not counted toward the episode allowance",
			gb(c.episode.NoEffect.Evicted), signedGB(c.episode.NoEffect.FreeDelta))
	}
}

func (c *core) observeClock() {
	c.jumped = false
	j := c.jumps.observe(c.wall.UnixNano(), c.mono, c.cfg.JumpTolerance)
	if j == 0 {
		return
	}
	c.jumped, c.changed = true, true
	c.lastJumpSecs = j / int64(time.Second)
	c.log.Printf("clock-jump seconds=%d: ages after a forward jump count awake time only; heartbeat and trim.txt rewritten now", c.lastJumpSecs)
	c.jumps.prune(c.wall.UnixNano(), 6*24*time.Hour)
	c.planAt, c.procAt = -1<<62, 0
	c.writeStatus() // persist the credit before anything is removed
}

func (c *core) sampleDisk() {
	free, err := c.cfg.Disk.Free()
	c.freeOK = err == nil
	if err != nil {
		return
	}
	c.free = free
	t := evict.NextTier(c.tier, free, c.limits())
	if t != c.tier {
		c.log.Printf("tier %s -> %s free=%s", c.tier, t, gb(free))
		c.tier, c.changed = t, true
		c.planAt = -1 << 62
	}
}

func (c *core) pressure() bool { return c.tier != evict.Normal }

// indexWork does this tick's scanning within ScanBudget, resuming next tick
// where it stopped. It returns whether initial indexing progressed.
func (c *core) indexWork(full bool) (indexed bool) {
	c.prio(!full)
	defer c.prio(false)
	if !c.idx.Complete() {
		c.indexTicks++
		before := c.idx.Progress()
		if c.idx.IndexStep(c.scanMore) {
			c.indexTicks = 0
			c.lastFullAt = c.wall
			c.relistAt, c.restatAt = c.mono, c.mono
			c.log.Printf("indexed entries=%d size=%s unmanaged=%s", c.idx.Entries(), gb(c.idx.Size()), gb(c.idx.UnmanagedBytes()))
			c.changed = true
		} else if before == 0 && c.idx.Progress() > 0 {
			c.log.Printf("indexing cache=%s", c.cfg.CacheDir)
		}
		return c.idx.Progress() > before && !c.idx.Complete()
	}
	every, cycle := c.cfg.IdleRelist, c.cfg.RestatCycle
	if c.pressure() {
		every, cycle = c.cfg.PressureRelist, c.cfg.PressureRestat
	}
	if c.mono-c.relistAt >= every && c.idx.Poll(c.scanMore) && c.idx.RelistDirty(c.scanMore) {
		c.relistAt = c.mono
	}
	// Buckets due since the last step (at most one cycle behind), so the
	// cycle holds at any tick length.
	c.restatAt = max(c.restatAt, c.mono-cycle)
	if n := int((c.mono - c.restatAt) * 256 / cycle); n > 0 && c.scanMore() {
		c.restatAt += time.Duration(c.idx.RestatStep(n, c.scanMore)) * cycle / 256
	}
	if c.mono-c.rootWalkAt >= c.cfg.RestatCycle && c.scanMore() && c.idx.WalkRoot(c.scanMore) {
		c.rootWalkAt = c.mono
	}
	return false
}

// refreshProcs recomputes the process-aware window.
func (c *core) refreshProcs(force bool) {
	if !force && c.mono-c.procAt < c.cfg.ProcEvery && c.procAt != 0 {
		return
	}
	c.procAt = c.mono
	l := c.limits()
	procs, err := c.cfg.Procs.List()
	c.procsOK = err == nil
	if c.procsOK {
		c.livePids = make(map[int32]bool, len(procs))
		for _, p := range procs {
			c.livePids[p.PID] = true
		}
	}
	w := l.Window
	why := ""
	if err != nil {
		// Without the table, assume a build as old as the cap is running.
		w, why = evict.ProcessWindow(l, l.ProcessAgeCap), "process table unreadable: "+err.Error()
	} else if p, age, ok := c.procs.Update(procs, c.cfg.Clock.Wall().UnixNano(), l.GoRunCap); ok {
		w = evict.ProcessWindow(l, age)
		if w > l.Window {
			why = fmt.Sprintf("%s pid %d started %s ago", p.Comm, p.PID, age.Round(time.Minute))
			if p.GoneAt != 0 {
				why += ", exited " + time.Duration(c.cfg.Clock.Wall().UnixNano()-p.GoneAt).Round(time.Minute).String() + " ago"
			}
		}
	}
	if cw := c.carried(); cw > w {
		w, why = cw, "the stopped run's window, carried over by the handover"
	}
	if w != c.window {
		c.changed = true
		if w > c.window+10*time.Minute || w < c.window-10*time.Minute {
			c.log.Printf("window %s -> %s %s", c.window, w.Round(time.Second), why)
		}
	}
	c.window, c.whyWin = w, why
}

// tierWindow is the shortest window the current tier allows.
func (c *core) tierWindow() time.Duration {
	switch c.tier {
	case evict.Emergency:
		return c.limits().EmergencyWindow
	case evict.Hard:
		return c.limits().HardWindow
	}
	return c.window
}

func (c *core) windows() evict.Windows {
	l := c.limits()
	return evict.Windows{Normal: c.window, Hard: l.HardWindow, Emergency: l.EmergencyWindow}
}

// refreshPlan re-sorts candidates when the plan is old, then re-assigns
// stage needs from live free disk (every tick: it is a linear pass).
func (c *core) refreshPlan(force bool) {
	c.refreshProcs(false)
	if force || c.mono-c.planAt >= c.cfg.PlanEvery || c.window != c.planWin {
		wall := c.wall.UnixNano()
		c.units = c.idx.Units(c.units[:0], wall, wall+int64(c.cfg.FutureTolerance))
		c.sorted = c.sorted[:0]
		for _, u := range c.units {
			if _, queued := c.pending[u.ID]; queued && u.Orphan {
				continue // already counted in pendingBytes
			}
			c.sorted = append(c.sorted, evict.Candidate{Unit: u, Age: c.jumps.age(wall, u.Recency)})
		}
		evict.Sort(c.sorted, c.cfg.Policy, c.window)
		c.planAt, c.planWin = c.mono, c.window
		c.pinMarked = 0
	}
	if c.pinMarked != c.live.version+1 {
		c.markPinned(c.sorted)
		c.pinMarked = c.live.version + 1
	}
	c.need, c.needOK = c.needs(), true
	c.plan = evict.Assign(c.sorted, c.need, c.windows(), c.room())
	short := c.need.Total() - c.plan.Bytes
	if behind := short > 0 && !c.plan.Capped && c.pressure(); behind != c.behind {
		c.behind, c.changed = behind, true
		if behind {
			c.log.Printf("cannot keep up: %s more needed, nothing else is outside the %s window, free=%s",
				gb(short), c.tierWindow().Round(time.Second), gb(c.free))
		}
	}
}

// needs is what each stage must still free, counting queued outputs as
// already freed so the plan doesn't pick replacements for them.
func (c *core) needs() evict.Need {
	size := c.idx.Size() - c.pendingBytes
	if !c.freeOK {
		// Unknown free disk: keep to the budget only.
		return evict.Needs(size, c.limits().DiskFloor*2, evict.Normal, c.limits())
	}
	return evict.Needs(size, c.free+c.pendingBytes, c.tier, c.limits())
}

// room is the plan's cap during a low-disk episode (-1 outside one): the
// episode's disk allowance plus whatever the budget alone requires, less the
// queued outputs.
func (c *core) room() int64 {
	r := c.episode.Room()
	if r < 0 {
		return r
	}
	return max(0, r+max(0, c.idx.Size()-c.limits().Budget)-c.pendingBytes)
}

// inGrace: no deletions for Window after start while free disk >= DiskFloor
// or unknown (amendment 3, D2). Awake time, so a sleep doesn't shorten it.
// None after a reboot since the last state.json; after a handover only what
// the stopped run had left, since the grace belongs to the ownership episode.
func (c *core) inGrace() bool {
	return (!c.freeOK || c.free >= c.limits().DiskFloor) && c.graceLeft() > 0
}

// graceLeft is the awake time of start grace left, free disk aside.
func (c *core) graceLeft() time.Duration {
	span := c.limits().Window
	switch {
	case c.noGrace:
		span = 0
	case c.handover != nil:
		span = c.handover.graceLeft
	}
	return max(0, span-(c.mono-c.startMono))
}

func (c *core) graceUntil() int64 {
	if !c.inGrace() {
		return 0
	}
	return c.wall.Add(c.graceLeft()).Unix()
}

func (c *core) logEpisode() {
	if c.episode.Active {
		c.log.Printf("low-disk episode tier=%s free=%s allowance=%s room=%s", c.tier, gb(c.free), gb(c.episode.Allowance()), gb(c.episode.Room()))
	} else {
		c.log.Printf("low-disk episode over free=%s", gb(c.free))
	}
	c.changed = true
}

func (c *core) maybeSummary() {
	if c.mono-c.lastSummary < 10*time.Minute || !c.idx.Complete() {
		return
	}
	c.lastSummary = c.mono
	cpu, rss := rusage()
	c.log.Printf("summary mode=%s tier=%s size=%s target=%s wouldEvict=%s protected=%s window=%s free=%s cpu=%s rss=%s",
		c.mode, c.tier, gb(c.idx.Size()), gb(c.need.Target), gb(c.plan.Bytes), gb(c.plan.Protected),
		c.window.Round(time.Second), gb(c.free), cpu.Round(time.Millisecond), gb(rss))
}

// signedGB is gb with an explicit sign: "+0.00GB".
func signedGB(n int64) string {
	if n >= 0 {
		return "+" + gb(n)
	}
	return gb(n)
}

// gb formats bytes for the log: "12.34GB".
func gb(n int64) string {
	return strconv.FormatFloat(float64(n)/float64(evict.GB), 'f', 2, 64) + "GB"
}
