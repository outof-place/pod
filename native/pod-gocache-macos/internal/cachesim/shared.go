package cachesim

import (
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// Shared models the state the daemon shares with go processes that run
// through the GOCACHEPROG client (S9): the published index, one slot per
// client with its log, and the dying table. It has the daemon's Shared
// methods; the client side is clientGet and clientPut, which follow
// store.Get and store.Put step by step.
type Shared struct {
	W       *World
	OpenErr error // test knob: Open fails with it
	// OnBegin runs right after a dying batch is published, before the
	// daemon drains: a scenario makes a client act inside the handshake.
	OnBegin func()

	open    bool
	entries map[[32]byte]index.Exact
	slots   [livestate.SlotCount]simSlot
	token   uint64
	dying   map[uint64]bool
	active  bool
	batchAt time.Duration
	Batches int
}

type simSlot struct {
	token uint64
	proc  *Proc
	recs  []livestate.Record
	at    []time.Duration // when each record was written (awake)
}

// Shared returns the world's shared-state model, creating it on first use.
// Only worlds that call it run go processes through the client.
func (w *World) Shared() *Shared {
	if w.shared == nil {
		w.shared = &Shared{W: w, entries: map[[32]byte]index.Exact{}}
	}
	return w.shared
}

func (s *Shared) Open() error {
	if s.OpenErr != nil {
		return s.OpenErr
	}
	s.open = true
	return nil
}

func (s *Shared) Close()                { s.open = false }
func (s *Shared) Where() string         { return "sim" }
func (s *Shared) Heartbeat(int64)       {}
func (s *Shared) Crowded() bool         { return false }
func (s *Shared) Unpublish(id index.ID) { delete(s.entries, id) }

// Reset starts an empty index, as a daemon start does.
func (s *Shared) Reset(int) error {
	clear(s.entries)
	return nil
}

func (s *Shared) Publish(id index.ID, e index.Exact) bool {
	s.entries[id] = e
	return true
}

func (s *Shared) IndexStats() (entries, slots, full int) { return len(s.entries), 1 << 16, 0 }

// Published is the entry the daemon published for id.
func (s *Shared) Published(id [32]byte) (index.Exact, bool) {
	e, ok := s.entries[id]
	return e, ok
}

func (s *Shared) Slot(i int, v *livestate.SlotView) bool {
	sl := &s.slots[i]
	*v = livestate.SlotView{Token: sl.token, LogLen: uint64(len(sl.recs))}
	if sl.proc != nil {
		v.PID = int(sl.proc.PID)
	}
	return true
}

func (s *Shared) Alive(i int) bool {
	p := s.slots[i].proc
	return p != nil && !p.dead
}

func (s *Shared) Records(i int, from, to uint64, dst []livestate.Record) ([]livestate.Record, bool) {
	return append(dst, s.slots[i].recs[from:to]...), true
}

func (s *Shared) BeginDying(prefixes []uint64) bool {
	s.dying = map[uint64]bool{}
	for _, p := range prefixes {
		s.dying[p] = true
	}
	s.active, s.batchAt = true, s.W.mono
	s.Batches++
	if s.OnBegin != nil {
		s.OnBegin()
	}
	return true
}

func (s *Shared) EndDying() bool {
	s.active, s.dying = false, nil
	return true
}

// claim gives a client process a free slot (a dead process's slot is free).
func (s *Shared) claim(p *Proc) {
	p.slot = -1
	for i := range s.slots {
		sl := &s.slots[i]
		if sl.proc == nil || sl.proc.dead {
			s.token++
			*sl = simSlot{token: s.token, proc: p}
			p.slot, p.seen = i, map[uint64]bool{}
			return
		}
	}
}

// pin is Slot.Pin: log the output (once per session unless a put or
// flagged), then report whether it is dying in a batch younger than
// BatchLife.
func (s *Shared) pin(p *Proc, out, action [32]byte, kind uint64) bool {
	if p.slot < 0 {
		return false
	}
	o := index.Prefix(out)
	if !p.seen[o] || kind&0xff >= livestate.KindPutStored || kind&0xff00 != 0 {
		p.seen[o] = true
		sl := &s.slots[p.slot]
		sl.recs = append(sl.recs, livestate.Record{Out: o, Action: index.Prefix(action), Kind: uint8(kind), Flags: uint16(kind & 0xff00)})
		sl.at = append(sl.at, s.W.mono)
	}
	return s.active && s.dying[o] && s.W.mono-s.batchAt < livestate.BatchLife
}

// pinnedBy reports whether a live client pinned output prefix o less than
// expiry ago.
func (s *Shared) pinnedBy(o uint64, expiry time.Duration) bool {
	for i := range s.slots {
		sl := &s.slots[i]
		if sl.proc == nil || sl.proc.dead {
			continue
		}
		for k, r := range sl.recs {
			if r.Out == o && s.W.mono-sl.at[k] < expiry {
				return true
			}
		}
	}
	return false
}

// clientGet is store.Get: the index entry when the -a file still has the
// inode and ctime it was published with, else the -a file; markUsed; the pin
// and the dying check; then the -d as get does.
func (w *World) clientGet(p *Proc, a *Action, wl *Workload) {
	s := w.shared
	af := w.lookup(a.ID, cachefs.KindAction)
	var out [32]byte
	kind := uint64(livestate.KindHitDisk)
	e, published := s.entries[a.ID]
	switch {
	case published && af == nil:
		w.GoneMisses++
		w.compile(p, a, wl) // the index had it and the -a is gone: a miss
		return
	case published && af.special == 0 && af.ino == e.Ino && af.ctime == e.Ctime:
		out, kind = e.Out, livestate.KindHitFast
		w.FastHits++
	default:
		if af == nil || af.special != 0 || af.content != nil {
			w.compile(p, a, wl)
			return
		}
		if published {
			kind |= livestate.RecordStale
		}
		w.read(af)
		out = af.out
		w.DiskHits++
	}
	if w.markUsedReport(af) {
		kind |= livestate.RecordRefreshed
	}
	if s.pin(p, out, a.ID, kind) {
		w.DyingMisses++
		w.compile(p, a, wl)
		return
	}
	w.After(30*time.Microsecond, func() { w.finishGet(p, a, wl, out) })
}

// clientPut is store.Put: pin an existing output before reusing it, write
// it again when it is dying, then the -a, then tell the daemon.
func (w *World) clientPut(p *Proc, a *Action, wl *Workload) {
	s := w.shared
	out := a.Out
	if a.Kind == TestLog {
		w.rng.Read(out[:])
	}
	gap := 50 * time.Microsecond
	kind := uint64(livestate.KindPutStored)
	d := w.lookup(out, cachefs.KindOutput)
	dying := d != nil && d.special == 0 && s.pin(p, out, a.ID, livestate.KindPutPin)
	if d != nil && d.special == 0 && !dying && (d.dir || d.size == a.Size) {
		if d.dir && d.inner != nil {
			w.read(d.inner)
		} else if !d.dir {
			w.read(d)
		}
		kind = livestate.KindPutExisting
		gap += time.Duration(float64(a.Size) / 1e9 * float64(time.Second))
	} else {
		if dying {
			w.DyingPuts++
		}
		w.writeOutput(a, out)
		gap += time.Duration(float64(a.Size) / 3e8 * float64(time.Second))
	}
	if wl != nil && w.rng.Float64() < wl.KillP {
		w.exit(p)
		return
	}
	w.After(gap, func() {
		if p.dead {
			return
		}
		w.writeAction(a, out)
		s.pin(p, out, a.ID, kind)
		if p.export {
			w.holdExport(p, out)
		}
	})
}

// ClientRace is a client that read a's -a an instant before the daemon
// removed it: it pins the output now and reads the -d later, as go would.
func (w *World) ClientRace(p *Proc, a *Action) {
	if w.shared.pin(p, a.Out, a.ID, livestate.KindHitDisk) {
		return // dying: answered as a miss
	}
	_, rel := a.Rels()
	w.hold(p, rel, false)
}

// ClientPin is a client's pin of a's output at this instant; it reports
// whether the client saw the output dying (and so answered a miss).
func (w *World) ClientPin(p *Proc, a *Action) bool {
	return w.shared.pin(p, a.Out, a.ID, livestate.KindHitFast)
}
