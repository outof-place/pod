package daemon

import (
	"cmp"
	"errors"
	"slices"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// Shared is the state the daemon shares with its clients (S9): livestate
// files in production (fileShared), a model in the simulation. Any failure
// turns the shared state off; S2's rules alone then decide, as before S9.
type Shared interface {
	// Open maps or creates the shared files for the cache directory as it
	// is now. ErrOtherPublisher: another daemon publishes for this cache.
	Open() error
	Close()
	// Reset starts a new, empty index sized for entries; readers of the old
	// one move over to it. Publish and Unpublish keep it current.
	Reset(entries int) error
	Publish(id index.ID, e index.Exact) bool
	Unpublish(id index.ID)
	Crowded() bool
	IndexStats() (entries, slots, full int)
	// Sync writes the index's informational counters, once per round.
	Sync()
	// Check reports what changed under the open files ("" for nothing): a
	// file deleted, replaced or cut short, the directory removed. Repair
	// puts them back; reindexed means every entry must be published again.
	Check() string
	Repair(entries int) (reindexed bool, err error)
	// Gens is how many clients files are mapped: the last is current, older
	// ones were deleted or replaced while clients held slots in them.
	// Retire unmaps older file g.
	Gens() int
	Retire(g int)
	// Slot reads slot i's header in clients file g. Alive asks the OS whether
	// the slot's holder lives: the claim is a lock that goes with the process.
	Slot(g, i int, v *livestate.SlotView) bool
	Alive(g, i int) bool
	Records(g, i int, from, to uint64, dst []livestate.Record) ([]livestate.Record, bool)
	// BeginDying publishes the outputs about to be removed, in every clients
	// file; EndDying retracts them once the removals are done.
	BeginDying(prefixes []uint64) bool
	EndDying() bool
	Heartbeat(wallNs int64)
	Where() string
}

// ErrOtherPublisher means another daemon holds the cache's publisher lock.
var ErrOtherPublisher = errors.New("another daemon publishes shared state for this cache")

// Pin defaults (decisions in the README): a pin lasts at most PinExpiry of
// awake time after the daemon first saw it, and pins keep at most PinCap
// bytes, the oldest live session's first; beyond it pins stop protecting.
const (
	DefaultPinExpiry = 6 * time.Hour
	DefaultPinCap    = 10 * evict.GB
)

type slotState struct {
	token      uint64
	cursor     uint64
	alive      bool
	pid, goPID int
	claimMono  int64 // the client's claim, awake ns: orders sessions for the pin cap
	claimWall  int64
	overflow   bool
	ended      bool                     // its counts joined the ended sessions'
	pins       map[uint64]time.Duration // output prefix -> awake time first seen
	counts     sessionCounts            // as the client last reported them
}

// sessionCounts are what a client reports in its slot (informational).
type sessionCounts struct {
	fast, disk, misses, puts uint64
	reason                   livestate.Reason
	reported                 bool
}

func (a *sessionCounts) add(b sessionCounts) {
	a.fast, a.disk, a.misses, a.puts = a.fast+b.fast, a.disk+b.disk, a.misses+b.misses, a.puts+b.puts
}

// slotGen is the daemon's view of one clients file's slots.
type slotGen struct {
	slots   [livestate.SlotCount]slotState
	retired time.Duration // when a newer file replaced it (0: current)
}

// oldGenGrace keeps an older clients file mapped at least this long after it
// was replaced: a client that opened it just before may claim a slot late.
const oldGenGrace = time.Minute

type pin struct {
	slots int32 // live slots holding it
}

// live is the daemon's side of the shared state.
type live struct {
	sh      Shared // nil: disabled
	open    bool
	reason  string
	other   bool // ErrOtherPublisher: this daemon must not remove outputs
	retryAt time.Duration
	batchAt time.Duration // when the active dying batch began (daemon clock)
	rootGen uint32
	expiry  time.Duration
	cap     int64

	gens     []*slotGen // one per mapped clients file, the current one last
	pins     map[uint64]*pin
	version  uint64          // bumped whenever the pin set changes
	capped   map[uint64]bool // pins over the cap at the last plan
	hints    []uint64        // action prefixes clients asked to re-read
	recs     []livestate.Record
	expireAt time.Duration

	clients, pinning, overflowed int
	overflowSince                int64 // wall ns: the oldest overflowed live session's start, 0 none
	pinnedBytes, overCap         int64
	records, rereads, batches    uint64
	skipped                      uint64 // outputs kept because a live client pinned them
	overflowKept                 uint64 // removals skipped for an overflowed session
	repairs                      uint64
	lastRepair                   string
	ended                        sessionCounts               // summed over sessions that ended
	endedReasons                 map[livestate.Reason]uint64 // ended sessions by index reason
}

func newLive(sh Shared, expiry time.Duration, capBytes int64) *live {
	return &live{sh: sh, expiry: expiry, cap: capBytes, pins: map[uint64]*pin{}, capped: map[uint64]bool{},
		endedReasons: map[livestate.Reason]uint64{}, reason: "not started"}
}

// close unmaps the shared files and releases the publisher lock.
func (l *live) close() {
	if l.sh != nil {
		l.sh.Close()
	}
	l.open = false
}

func (l *live) fail(c *core, why string) {
	if l.open {
		c.log.Printf("shared state off: %s (retry in 1m; S2 rules alone decide meanwhile)", why)
	}
	l.end(c, why, c.mono+time.Minute)
}

// stop ends sharing without counting it as a failure (owner mode lost).
func (l *live) stop(c *core, why string) {
	if l.open {
		c.log.Printf("shared state off: %s", why)
	}
	l.end(c, why, c.mono)
}

func (l *live) end(c *core, why string, retryAt time.Duration) {
	if l.open {
		l.sh.Close()
	}
	l.open, l.reason, l.retryAt = false, why, retryAt
	for _, g := range l.gens {
		for i := range g.slots {
			l.endSlot(&g.slots[i])
		}
	}
	l.gens = nil
	c.changed = true
}

// step is the tick's shared-state work: open or follow the cache directory,
// drain client logs, re-read what clients found stale, publish what the
// index learned.
func (c *core) liveStep() {
	l := c.live
	if l.sh == nil {
		return
	}
	if c.mode != ownerstate.ModeOwner {
		// Only the cache's owner publishes: an observe daemon holding the
		// publisher lock would keep the owner from removing anything.
		if l.open || l.reason != notOwner {
			l.stop(c, notOwner)
		}
		return
	}
	if l.open && l.rootGen != c.idx.RootGen() {
		l.fail(c, "cache directory replaced")
		l.retryAt = c.mono
	}
	if !l.open {
		if (c.mono < l.retryAt && l.reason != notOwner) || !c.idx.RootOK() {
			return
		}
		if !c.openLive() {
			return
		}
	} else if why := l.sh.Check(); why != "" && !c.repairLive(why) {
		return
	}
	if !l.drain(c, c.mono, true) {
		return
	}
	c.applyHints()
	c.publishChanged()
	if c.mono >= l.expireAt {
		l.expire(c.mono)
		l.expireAt = c.mono + time.Minute
	}
	l.sh.Heartbeat(c.wall.UnixNano())
}

func (c *core) openLive() bool {
	l := c.live
	err := l.sh.Open()
	if err == nil {
		err = l.sh.Reset(c.idx.Actions())
	}
	if err != nil {
		if err.Error() != l.reason {
			c.log.Printf("shared state unavailable: %v (retry every 1m)", err)
			c.changed = true
		}
		l.reason, l.other, l.retryAt = err.Error(), errors.Is(err, ErrOtherPublisher), c.mono+time.Minute
		l.sh.Close()
		return false
	}
	l.open, l.reason, l.other, l.rootGen = true, "", false, c.idx.RootGen()
	l.syncGens(c.mono)
	c.republish()
	c.log.Printf("shared state at %s", l.sh.Where())
	c.changed = true
	return true
}

// notOwner is the reason shown while the daemon does not own the cache.
const notOwner = "observe mode: only the cache's owner shares state with clients"

func (c *core) republish() {
	l := c.live
	c.idx.TakeChanged(func(index.ID) {})
	c.idx.EachExact(func(id index.ID, e index.Exact) { l.sh.Publish(id, e) })
	l.sh.Sync()
}

// repairLive puts back shared files deleted or replaced under the daemon.
// Clients that hold slots in a replaced clients file keep their pins: the
// old file stays mapped and drained until none of them lives.
func (c *core) repairLive(why string) bool {
	l := c.live
	c.log.Printf("shared state: %s; recreating it", why)
	l.repairs++
	l.lastRepair = c.wall.Format("15:04:05") + " " + why
	c.changed = true
	reindexed, err := l.sh.Repair(c.idx.Actions())
	if err != nil {
		l.fail(c, "repair: "+err.Error())
		l.other = errors.Is(err, ErrOtherPublisher)
		return false
	}
	l.syncGens(c.mono)
	if reindexed {
		c.republish()
	}
	return true
}

// syncGens follows the Shared's clients files: a new current one is added
// last, and the previous one starts its retirement.
func (l *live) syncGens(now time.Duration) {
	for len(l.gens) < l.sh.Gens() {
		if n := len(l.gens); n > 0 {
			l.gens[n-1].retired = now
		}
		l.gens = append(l.gens, &slotGen{})
	}
}

// retire drops older clients file g: its sessions end for the daemon.
func (l *live) retire(g int) {
	for i := range l.gens[g].slots {
		l.endSlot(&l.gens[g].slots[i])
	}
	l.sh.Retire(g)
	l.gens = slices.Delete(l.gens, g, g+1)
}

// drain reads every slot's new records into pins and hints, in every
// clients file mapped. full also asks the OS which slots' holders still
// live; a quick drain (between removals) only reads records of slots already
// known to be alive.
func (l *live) drain(c *core, now time.Duration, full bool) bool {
	var v livestate.SlotView
	clients, pinning, overflowed := 0, 0, 0
	var since int64
	cur := len(l.gens) - 1
	for g := cur; g >= 0; g-- {
		gen := l.gens[g]
		alive := 0
		for i := range gen.slots {
			st := &gen.slots[i]
			if !full && !st.alive {
				continue
			}
			if !l.sh.Slot(g, i, &v) {
				if g == cur {
					l.fail(c, "client slots unreadable")
					return false
				}
				l.retireBroken(c, g)
				cur--
				alive = -1
				break
			}
			if v.Token == 0 {
				l.endSlot(st)
				*st = slotState{}
				continue
			}
			if v.Token != st.token || v.LogLen < st.cursor {
				// A new client, or one still writing its claim: start over.
				l.endSlot(st)
				*st = slotState{token: v.Token}
			}
			st.counts = sessionCounts{fast: v.FastHits, disk: v.DiskHits, misses: v.Misses, puts: v.Puts, reason: v.Reason, reported: v.Reported}
			if full {
				if !l.sh.Alive(g, i) {
					// Ended since the last drain: its pins end with it, its requests
					// to re-read entries (stale ones, puts) still count.
					if !l.read(g, i, st, &v, false, now) {
						if g == cur {
							l.fail(c, "client logs unreadable")
							return false
						}
						l.retireBroken(c, g)
						cur--
						alive = -1
						break
					}
					l.endSlot(st)
					continue
				}
				st.alive, st.pid, st.goPID, st.claimMono, st.claimWall = true, v.PID, v.GoPID, v.ClaimMono, v.ClaimWall
			}
			if !l.read(g, i, st, &v, true, now) {
				if g == cur {
					l.fail(c, "client logs unreadable")
					return false
				}
				l.retireBroken(c, g)
				cur--
				alive = -1
				break
			}
			st.overflow = v.Flags&livestate.FlagOverflow != 0
			alive++
			clients++
			if len(st.pins) > 0 {
				pinning++
			}
			if st.overflow {
				overflowed++
				if start := l.sessionStart(c, st); since == 0 || start < since {
					since = start
				}
			}
		}
		if full && g < cur && alive == 0 && now-gen.retired >= oldGenGrace {
			l.retire(g)
			cur--
		}
	}
	if full {
		l.clients, l.pinning, l.overflowed, l.overflowSince = clients, pinning, overflowed, since
	}
	return true
}

// retireBroken drops an older clients file that faults when read (cut
// short under the daemon): its sessions' pins can't be read any more.
func (l *live) retireBroken(c *core, g int) {
	c.log.Printf("an older clients file is unreadable (cut short): the pins of its sessions end")
	l.retire(g)
}

// sessionStart is when an overflowed session began (wall ns), as its client
// says, but never earlier than a pin may last.
func (l *live) sessionStart(c *core, st *slotState) int64 {
	floor := c.wall.UnixNano() - int64(l.expiry)
	if st.claimWall <= floor || st.claimWall > c.wall.UnixNano() {
		return floor
	}
	return st.claimWall
}

// endSlot ends a session for the daemon: its pins stop protecting and its
// counters join the ended sessions', once. Token and cursor stay, so a dead
// client's records are not read again.
func (l *live) endSlot(st *slotState) {
	if st.token != 0 && !st.ended {
		st.ended = true
		l.ended.add(st.counts)
		if st.counts.reported {
			l.endedReasons[st.counts.reason]++
		}
	}
	for p := range st.pins {
		l.unpin(p)
	}
	st.pins, st.alive, st.overflow = nil, false, false
}

// read takes slot i's records past the cursor: pins too when the client
// lives, re-read requests in any case. False: the log faulted.
func (l *live) read(g, i int, st *slotState, v *livestate.SlotView, pins bool, now time.Duration) bool {
	if v.LogLen <= st.cursor {
		return true
	}
	var ok bool
	l.recs, ok = l.sh.Records(g, i, st.cursor, v.LogLen, l.recs[:0])
	if !ok {
		return false
	}
	st.cursor = min(v.LogLen, livestate.LogRecords)
	l.records += uint64(len(l.recs))
	for _, r := range l.recs {
		if pins {
			l.take(st, r, now)
		} else {
			l.hint(r)
		}
	}
	return true
}

// take applies one record: a pin on its output, and a re-read of its -a when
// the client wrote it, refreshed it, or found the index out of date.
func (l *live) take(st *slotState, r livestate.Record, now time.Duration) {
	if st.pins == nil {
		st.pins = map[uint64]time.Duration{}
	}
	if _, ok := st.pins[r.Out]; !ok {
		st.pins[r.Out] = now
		p := l.pins[r.Out]
		if p == nil {
			p = &pin{}
			l.pins[r.Out] = p
		}
		p.slots++
		l.version++
	}
	l.hint(r)
}

// hint queues a re-read of the record's -a when it says the -a changed: a put,
// or a hit that refreshed its mtime or found the index stale.
func (l *live) hint(r livestate.Record) {
	if r.Kind == livestate.KindPutStored || r.Kind == livestate.KindPutExisting || r.Flags != 0 {
		l.hints = append(l.hints, r.Action)
	}
}

func (l *live) unpin(prefix uint64) {
	if p := l.pins[prefix]; p != nil {
		if p.slots--; p.slots <= 0 {
			delete(l.pins, prefix)
		}
		l.version++
	}
}

// expire drops pins first seen more than expiry ago, whatever the client
// wrote: a pin's lifetime is bounded by the daemon's own clock.
func (l *live) expire(now time.Duration) {
	for _, g := range l.gens {
		for i := range g.slots {
			st := &g.slots[i]
			for p, at := range st.pins {
				if now-at >= l.expiry {
					delete(st.pins, p)
					l.unpin(p)
				}
			}
		}
	}
}

// overflowCut lowers a removal's cutoff while a live client's log is full
// (its later outputs are not pinned): outside the emergency tier, nothing
// used since that session began goes.
func (l *live) overflowCut(cut int64, tier evict.Tier) int64 {
	if !l.open || l.overflowSince == 0 || tier == evict.Emergency || cut <= l.overflowSince {
		return cut
	}
	return l.overflowSince
}

// keeps reports whether a live client pinned the output id (within the cap).
func (l *live) keeps(id index.ID) bool {
	if !l.open {
		return false
	}
	p := index.Prefix(id)
	return l.pins[p] != nil && !l.capped[p]
}

// unitKept reports whether a planned unit's output is pinned now. A unit
// planned to give way does so only while the emergency lasts.
func (l *live) unitKept(u *evict.Planned, tier evict.Tier) bool {
	if u.GaveWay && tier == evict.Emergency {
		return false
	}
	if u.Orphan {
		return l.keeps(u.ID)
	}
	return u.HasOut && l.keeps(u.Out)
}

func (c *core) applyHints() {
	l := c.live
	if len(l.hints) == 0 {
		return
	}
	slices.Sort(l.hints)
	l.hints = slices.Compact(l.hints)
	dirty := false
	for _, p := range l.hints {
		found := false
		listed := c.idx.ActionsWithPrefix(p, func(id index.ID) {
			found = true
			c.idx.Reread(id)
			l.rereads++
		})
		if !found && listed {
			c.idx.MarkBucketDirty(byte(p))
			dirty = true
		}
	}
	l.hints = l.hints[:0]
	if dirty && c.idx.Complete() {
		c.idx.RelistDirty(c.scanMore)
	}
}

func (c *core) publishChanged() {
	l := c.live
	c.idx.TakeChanged(func(id index.ID) {
		if e, ok := c.idx.ActionEntry(id); ok {
			l.sh.Publish(id, e)
		} else {
			l.sh.Unpublish(id)
		}
	})
	if l.sh.Crowded() {
		if err := l.sh.Reset(c.idx.Actions()); err != nil {
			l.fail(c, "index rebuild: "+err.Error())
			return
		}
		c.idx.EachExact(func(id index.ID, e index.Exact) { l.sh.Publish(id, e) })
	}
	l.sh.Sync()
}

// markPinned flags pinned candidates and applies the byte cap: pins of the
// oldest live session keep protection first, up to PinCap; the rest stop
// protecting. A long build's early outputs are the ones it reads last.
func (c *core) markPinned(cands []evict.Candidate) {
	l := c.live
	l.pinnedBytes, l.overCap = 0, 0
	clear(l.capped)
	if !l.open || len(l.pins) == 0 {
		for i := range cands {
			cands[i].Pinned = false
		}
		return
	}
	oldest := make(map[uint64]int64, len(l.pins)) // pin -> earliest claim among its live sessions
	for _, g := range l.gens {
		for i := range g.slots {
			st := &g.slots[i]
			for p := range st.pins {
				if at, ok := oldest[p]; !ok || st.claimMono < at {
					oldest[p] = st.claimMono
				}
			}
		}
	}
	type held struct {
		prefix uint64
		claim  int64
		bytes  int64
	}
	var hs []held
	seen := map[uint64]bool{}
	for i := range cands {
		u := &cands[i]
		out := u.Out
		if u.Orphan {
			out = u.ID
		}
		p := index.Prefix(out)
		u.Pinned = l.pins[p] != nil && (u.HasOut || u.Orphan)
		if u.Pinned && !seen[p] {
			seen[p] = true
			hs = append(hs, held{prefix: p, claim: oldest[p], bytes: u.DBytes})
		}
	}
	slices.SortFunc(hs, func(a, b held) int {
		return cmp.Or(cmp.Compare(a.claim, b.claim), cmp.Compare(a.prefix, b.prefix))
	})
	for _, h := range hs {
		if l.pinnedBytes+h.bytes > l.cap {
			l.capped[h.prefix] = true
			l.overCap += h.bytes
			continue
		}
		l.pinnedBytes += h.bytes
	}
	if len(l.capped) > 0 {
		for i := range cands {
			u := &cands[i]
			out := u.Out
			if u.Orphan {
				out = u.ID
			}
			if u.Pinned && l.capped[index.Prefix(out)] {
				u.Pinned = false
			}
		}
	}
}

// beginDying publishes ids as dying, then drains: from here on a client
// either pinned an output before the batch (and the drain sees it) or sees
// the batch and answers its get as a miss.
func (c *core) beginDying(ids []index.ID) bool {
	l := c.live
	if !l.open {
		return true
	}
	prefixes := make([]uint64, len(ids))
	for i, id := range ids {
		prefixes[i] = index.Prefix(id)
	}
	l.batchAt = c.cfg.Clock.Mono() // before the file's stamp: never younger than clients judge it
	if !l.sh.BeginDying(prefixes) {
		l.fail(c, "dying table unwritable")
		return false
	}
	l.batches++
	return l.drain(c, c.cfg.Clock.Mono(), true)
}

// batchFresh reports whether clients still honor the active batch with room
// to spare: past half of BatchLife the daemon starts a new one instead.
func (l *live) batchFresh(now time.Duration) bool {
	return !l.open || now-l.batchAt < livestate.BatchLife/2
}

func (c *core) endDying() {
	if c.live.open && !c.live.sh.EndDying() {
		c.live.fail(c, "dying table unwritable")
	}
}
