package cachesim

import (
	"encoding/hex"
	"slices"
	"strings"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/procscan"
)

// checkMode: nothing may be written or removed in observe mode once the
// daemon had a tick to notice the switch.
// An unreadable or half-written mode file counts once it stays so for a
// second (the daemon's debounce), so allow that plus a tick.
func (w *World) checkMode(what string) {
	since := w.tickStart
	if !w.ModeValid {
		since = w.tickStart - 3*time.Second
	}
	if w.ModeNow != "owner" && w.modeChangedAt < since {
		w.violate("%s in observe mode", what)
	}
}

// legalWindow is the smallest window the rules allow at the daemon's last
// free-disk sample, computed independently of the daemon's code.
func (w *World) legalWindow() time.Duration {
	free := w.freeSamples[1]
	switch {
	case free >= w.L.HardFloor+w.L.Hysteresis:
		return w.processWindow()
	case free >= w.L.EmergencyFloor+w.L.Hysteresis:
		return w.L.HardWindow
	}
	return w.L.EmergencyWindow
}

// processWindow re-derives amendment 3 D1 from the process snapshot the
// daemon last read: max(T, min(oldest go-family age, cap) + margin), with
// gopls and a go process that only waits on a non-go child counted as at most
// GoRunCap old.
func (w *World) processWindow() time.Duration {
	kids := map[int32][]string{}
	for _, p := range w.lastProcList {
		kids[p.PPID] = append(kids[p.PPID], p.Comm)
	}
	family := func(c string) bool {
		switch c {
		case "go", "compile", "link", "asm", "cgo", "vet", "golangci-lint", "gopls":
			return true
		}
		return strings.HasSuffix(c, ".test")
	}
	var oldest time.Duration = -1
	for _, p := range w.lastProcList {
		if !family(p.Comm) {
			continue
		}
		age := time.Duration(w.lastProcWall - p.Start)
		if p.Comm == "gopls" || (p.Comm == "go" && len(kids[p.PID]) > 0 && !slices.ContainsFunc(kids[p.PID], family)) {
			age = min(age, w.L.GoRunCap)
		}
		oldest = max(oldest, min(age, w.L.ProcessAgeCap))
	}
	win := w.L.Window
	if oldest >= 0 {
		win = max(win, oldest+w.L.ProcessMargin)
	}
	return win
}

func (w *World) checkRemoval(rel string, f, in *file) {
	w.checkMode("remove " + rel)
	free := w.freeSamples[1]
	if free >= w.L.DiskFloor && w.mono-w.daemonStart < w.L.Window {
		w.violate("removed %s inside the start grace (free %d)", rel, free)
	}
	win := w.legalWindow()
	target := f
	if in != nil {
		target = in
	}
	if age := w.mono - target.recMono; age <= win {
		w.violate("removed %s with recency %s ago (awake), window %s, free %.1fGB", rel, age, win, float64(free)/1e9)
	}
	if in != nil && w.mono-f.recMono <= win {
		w.violate("removed executable in %s whose directory changed %s ago", rel, w.mono-f.recMono)
	}
	if isAction(rel) {
		// The pair rule: an -a is as recent as its output.
		if d := w.lookup(f.out, cachefs.KindOutput); d != nil && w.mono-d.visibleAt() <= win {
			w.violate("removed %s whose output's recency is %s ago, window %s", rel, w.mono-d.visibleAt(), win)
		}
		return
	}
	w.checkRefs(rel)
}

// checkRefs: an output is never removed while an -a that existed before this
// daemon tick references it. An -a written during the tick is the documented
// put race; it is counted, not failed.
func (w *World) checkRefs(rel string) {
	id, _, ok := entryID(rel)
	if !ok {
		return
	}
	for i := range w.fs.b {
		bk := &w.fs.b[i]
		if !bk.present {
			continue
		}
		for n, a := range bk.files {
			if !strings.HasSuffix(n, "-a") || a.out != id || a.special != 0 {
				continue
			}
			if a.written < w.tickStart {
				w.violate("removed %s while %s/%s references it", rel, cachefs.BucketName(i), n)
			} else {
				w.ConcurrentRefs++
			}
		}
	}
}

func bucketIndex(rel string) int {
	b, _ := cachefs.ParseBucketName(rel[:2])
	return b
}

// entryID parses the entry a path names, including a file inside an
// executable -d directory.
func entryID(rel string) (id [32]byte, kind byte, ok bool) {
	name := rel[3:]
	if i := strings.IndexByte(name, '/'); i >= 0 {
		name = name[:i]
	}
	return cachefs.ParseEntryName(bucketIndex(rel), name)
}

// d4State replays the daemon's low-disk episodes from its free-disk samples
// for the amended D4 bound: eviction below the budget in one episode stays
// within the largest deficit free disk would have had without the daemon's
// own removals in it, plus one unit.
type d4State struct {
	tier     int
	active   bool
	released int64 // bytes the daemon's removals gave back to the disk
	forDisk  int64 // bytes of units it chose with the cache at or below the budget
	maxExt   int64
	maxUnit  int64
}

// d4Pend is an output whose -a the daemon removed; it goes with the decision
// made for the -a: that episode, budget or disk.
type d4Pend struct {
	ep     int
	budget bool
}

// d4Sample follows a free-disk sample through the daemon's tier rules.
func (w *World) d4Sample(free int64) {
	th := [...]int64{0, w.L.DiskFloor, w.L.HardFloor, w.L.EmergencyFloor}
	t := 0
	for tier := 1; tier <= 3; tier++ {
		if free < th[tier] || (w.d4.tier >= tier && free < th[tier]+w.L.Hysteresis) {
			t = tier
		}
	}
	if t == 0 {
		w.d4 = d4State{}
		return
	}
	if !w.d4.active {
		w.d4 = d4State{active: true}
		w.D4Episodes++
	}
	w.d4.tier = t
	w.d4.maxExt = max(w.d4.maxExt, w.L.DiskFloor-(free-w.d4.released))
}

// d4Removed counts a removal by the daemon of n bytes at rel; f is the file
// removed, nil for a client temp file, which frees disk but is no eviction.
// A unit chosen while the cache was over the budget keeps to the budget, even
// when it is larger than the excess: that is unit granularity, not disk.
func (w *World) d4Removed(rel string, f *file, n int64) {
	if w.d4.active && !w.disk.FreeIgnoresRemovals {
		w.d4.released += n
	}
	id, kind, entry := entryID(rel)
	if !entry || f == nil || f.dir || w.L.Budget == 0 {
		return // a temp file, or the directory an executable leaves behind
	}
	if w.d4Outs == nil {
		w.d4Outs = map[[32]byte]d4Pend{}
	}
	budget := w.disk.used-w.tempUsed > w.L.Budget
	ep := 0
	if w.d4.active {
		ep = w.D4Episodes
	}
	if kind == cachefs.KindAction {
		if w.lookup(f.out, cachefs.KindOutput) != nil {
			w.d4Outs[f.out] = d4Pend{ep: ep, budget: budget}
		}
	} else if p, ok := w.d4Outs[id]; ok {
		delete(w.d4Outs, id)
		if p.ep != ep {
			return // counted with its -a, in another episode or none
		}
		budget = p.budget
	}
	if !w.d4.active || budget {
		return
	}
	w.d4.forDisk += n
	w.d4.maxUnit = max(w.d4.maxUnit, n)
	excess := w.d4.forDisk - w.d4.maxExt
	w.D4Excess = max(w.D4Excess, excess)
	if excess > 2*w.d4.maxUnit+10_000_000 {
		w.violate("evicted %d bytes for disk in this episode; the largest deficit without the daemon's removals was %d", w.d4.forDisk, w.d4.maxExt)
	}
}

// --- process table, mode switch, status sink, priority ---

// ProcSnap is a process table row as the daemon sees it.
type ProcSnap = procscan.Proc

// List implements procscan.Lister.
func (w *World) List() ([]procscan.Proc, error) {
	w.op()
	pids := make([]int32, 0, len(w.procs))
	for pid := range w.procs {
		pids = append(pids, pid)
	}
	slices.Sort(pids)
	out := make([]procscan.Proc, 0, len(pids))
	for _, pid := range pids {
		p := w.procs[pid]
		out = append(out, procscan.Proc{PID: p.PID, PPID: p.PPID, Start: p.Start, Comm: p.Comm})
	}
	w.lastProcList, w.lastProcWall = out, w.WallNs()
	return out, nil
}

// ModeSource is the simulated mode file.
type ModeSource struct{ W *World }

func (m ModeSource) Stat() ownerstate.ModeKey {
	return ownerstate.ModeKey{Exists: true, Ino: 7, Mtime: int64(m.W.modeKeySeq), Size: int64(len(m.W.ModeNow))}
}

func (m ModeSource) Read() (string, bool, string) {
	if !m.W.ModeValid {
		return "observe", false, "sim: invalid mode file"
	}
	return m.W.ModeNow, true, "sim mode " + m.W.ModeNow
}

// Sink records the daemon's status writes.
type Sink struct {
	W     *World
	First ownerstate.State
	Last  ownerstate.State
	Owner ownerstate.Owner
	wrote bool
}

func (s *Sink) WriteOwner(o ownerstate.Owner) error {
	s.Owner = o
	bg := len(s.W.BG) > 0 && s.W.BG[0]
	s.W.Owners = append(s.W.Owners, OwnerBeat{Mono: s.W.mono, HeartbeatAt: o.HeartbeatAt, Mode: o.Mode, Background: bg})
	return nil
}

func (s *Sink) WriteState(st ownerstate.State) error {
	if !s.wrote {
		s.First = st
	}
	s.Last, s.wrote = st, true
	return nil
}

func (s *Sink) Previous() (ownerstate.State, bool) { return s.Last, s.wrote }

// Restore makes st the state.json a previous run left behind.
func (s *Sink) Restore(st ownerstate.State) { s.First, s.Last, s.wrote = st, st, true }

// Prio records whether eviction ran throttled.
type Prio struct{ W *World }

func (p Prio) Background(on bool) {
	if on && p.W.freeSamples[1] < p.W.L.HardFloor {
		p.W.violate("throttled I/O below the hard floor")
	}
	p.W.BG = append(p.W.BG[:0], on)
}

var _ cachefs.FS = (*World)(nil)

// checkPinned records an output removed while a live client process pinned
// it; the test decides which tiers allow that (B1: emergency only).
func (w *World) checkPinned(rel string) {
	if w.shared == nil || !strings.HasSuffix(strings.SplitN(rel, "/", 3)[1], "-d") {
		return
	}
	name := strings.SplitN(rel, "/", 3)[1]
	var out [32]byte
	if _, err := hex.Decode(out[:], []byte(name[:64])); err != nil {
		return
	}
	expiry := w.PinExpiry
	if expiry == 0 {
		expiry = 6 * time.Hour
	}
	if w.shared.pinnedBy(index.Prefix(out), expiry) {
		w.PinnedRemovals = append(w.PinnedRemovals, Removal{Rel: rel, Mono: w.mono, FreeAtCut: w.freeSamples[1], Live: w.liveGo()})
	}
}
