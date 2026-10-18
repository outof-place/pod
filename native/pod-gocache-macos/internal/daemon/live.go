package daemon

import (
	"cmp"
	"errors"
	"slices"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
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
	// Slot reads client slot i's header. Alive asks the OS whether the slot's
	// holder lives: the claim is a lock that goes with the process.
	Slot(i int, v *livestate.SlotView) bool
	Alive(i int) bool
	Records(i int, from, to uint64, dst []livestate.Record) ([]livestate.Record, bool)
	// BeginDying publishes the outputs about to be removed; EndDying
	// retracts them once the removals are done.
	BeginDying(prefixes []uint64) bool
	EndDying() bool
	Heartbeat(wallNs int64)
	Where() string
}

// ErrOtherPublisher means another daemon holds the cache's publisher lock.
var ErrOtherPublisher = errors.New("another daemon publishes shared state for this cache")

// Pin defaults (decisions in the README): a pin lasts at most PinExpiry of
// awake time after the daemon first saw it, and pins keep at most PinCap
// bytes; beyond it the pins first taken longest ago stop protecting.
const (
	DefaultPinExpiry = 6 * time.Hour
	DefaultPinCap    = 10 * evict.GB
)

type slotState struct {
	token    uint64
	cursor   uint64
	alive    bool
	pid      int
	overflow bool
	pins     map[uint64]time.Duration // output prefix -> awake time first seen
}

type pin struct {
	slots  int32         // live slots holding it
	newest time.Duration // the latest first sighting: how recently a session took it
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

	slots    [livestate.SlotCount]slotState
	pins     map[uint64]*pin
	version  uint64          // bumped whenever the pin set changes
	capped   map[uint64]bool // pins over the cap at the last plan
	hints    []uint64        // action prefixes clients asked to re-read
	recs     []livestate.Record
	expireAt time.Duration

	clients, pinning, overflowed int
	pinnedBytes, overCap         int64
	records, rereads, batches    uint64
	skipped                      uint64 // outputs kept because a live client pinned them
	keepUp                       string
}

func newLive(sh Shared, expiry time.Duration, capBytes int64) *live {
	return &live{sh: sh, expiry: expiry, cap: capBytes, pins: map[uint64]*pin{}, capped: map[uint64]bool{}, reason: "not started"}
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
		l.sh.Close()
	}
	l.open, l.reason, l.retryAt = false, why, c.mono+time.Minute
	for i := range l.slots {
		l.dropSlot(i)
		l.slots[i] = slotState{}
	}
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
	if l.open && l.rootGen != c.idx.RootGen() {
		l.fail(c, "cache directory replaced")
		l.retryAt = c.mono
	}
	if !l.open {
		if c.mono < l.retryAt || !c.idx.RootOK() {
			return
		}
		if !c.openLive() {
			return
		}
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
	c.idx.TakeChanged(func(index.ID) {})
	c.idx.EachExact(func(id index.ID, e index.Exact) { l.sh.Publish(id, e) })
	c.log.Printf("shared state at %s", l.sh.Where())
	c.changed = true
	return true
}

// drain reads every slot's new records into pins and hints. full also asks
// the OS which slots' holders still live; a quick drain (between removals)
// only reads records of slots already known to be alive.
func (l *live) drain(c *core, now time.Duration, full bool) bool {
	var v livestate.SlotView
	clients, pinning, overflowed := 0, 0, 0
	for i := range l.slots {
		st := &l.slots[i]
		if !full && !st.alive {
			continue
		}
		if !l.sh.Slot(i, &v) {
			l.fail(c, "client slots unreadable")
			return false
		}
		if v.Token == 0 {
			l.dropSlot(i)
			*st = slotState{}
			continue
		}
		if v.Token != st.token || v.LogLen < st.cursor {
			// A new client, or one still writing its claim: start over.
			l.dropSlot(i)
			*st = slotState{token: v.Token}
		}
		if full {
			if !l.sh.Alive(i) {
				// Ended since the last drain: its pins end with it, its requests
				// to re-read entries (stale ones, puts) still count.
				if !l.read(c, i, st, &v, false, now) {
					return false
				}
				l.dropSlot(i)
				st.alive = false
				continue
			}
			st.alive, st.pid = true, v.PID
		}
		if !l.read(c, i, st, &v, true, now) {
			return false
		}
		st.overflow = v.Flags&livestate.FlagOverflow != 0
		clients++
		if len(st.pins) > 0 {
			pinning++
		}
		if st.overflow {
			overflowed++
		}
	}
	if full {
		l.clients, l.pinning, l.overflowed = clients, pinning, overflowed
	}
	return true
}

// take applies one record: a pin on its output, and a re-read of its -a when
// the client wrote it, refreshed it, or found the index out of date.
// read takes slot i's records past the cursor: pins too when the client
// lives, re-read requests in any case.
func (l *live) read(c *core, i int, st *slotState, v *livestate.SlotView, pins bool, now time.Duration) bool {
	if v.LogLen <= st.cursor {
		return true
	}
	var ok bool
	l.recs, ok = l.sh.Records(i, st.cursor, v.LogLen, l.recs[:0])
	if !ok {
		l.fail(c, "client logs unreadable")
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
		p.newest = max(p.newest, now)
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

func (l *live) dropSlot(i int) {
	st := &l.slots[i]
	for p := range st.pins {
		l.unpin(p)
	}
	st.pins = nil
}

// expire drops pins first seen more than expiry ago, whatever the client
// wrote: a pin's lifetime is bounded by the daemon's own clock.
func (l *live) expire(now time.Duration) {
	for i := range l.slots {
		st := &l.slots[i]
		for p, at := range st.pins {
			if now-at >= l.expiry {
				delete(st.pins, p)
				l.unpin(p)
			}
		}
	}
}

// keeps reports whether a live client pinned the output id (within the cap).
func (l *live) keeps(id index.ID) bool {
	if !l.open {
		return false
	}
	p := index.Prefix(id)
	return l.pins[p] != nil && !l.capped[p]
}

// unitKept reports whether a planned unit's output is pinned now.
func (l *live) unitKept(u *evict.Planned) bool {
	if u.GaveWay {
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
}

// markPinned flags pinned candidates and applies the byte cap: the pins most
// recently taken keep protection up to PinCap, the rest stop protecting.
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
	type held struct {
		prefix uint64
		newest time.Duration
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
		pn := l.pins[p]
		u.Pinned = pn != nil && (u.HasOut || u.Orphan)
		if u.Pinned && !seen[p] {
			seen[p] = true
			hs = append(hs, held{prefix: p, newest: pn.newest, bytes: u.DBytes})
		}
	}
	slices.SortFunc(hs, func(a, b held) int {
		return cmp.Or(cmp.Compare(b.newest, a.newest), cmp.Compare(a.prefix, b.prefix))
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
