package cachesim

import (
	"crypto/sha256"
	"math"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
)

// ActKind is what an action produces.
type ActKind uint8

const (
	Archive ActKind = iota // deterministic output
	Exec                   // a go run executable: an -d directory
	TestLog                // a different output on every run
	Empty                  // the shared empty output
)

// Action is one cache key with the output it produces.
type Action struct {
	ID   [32]byte
	Out  [32]byte
	Size int64
	Kind ActKind
}

// Workload is the go activity on the simulated machine.
type Workload struct {
	Actions   []*Action
	SpawnMean time.Duration // mean gap between go commands
	MaxLife   time.Duration
	MaxLooks  int
	ExportP   float64 // go list -export, with a reader after it exits
	KillP     float64 // killed between writing an output and its -a
	GoRunP    float64
	LongP     float64 // a long go test (up to MaxLife x 4)
	HotSize   int
	Drift     time.Duration
	hot       int
}

// NewWorkload makes n actions with a realistic size mix.
func (w *World) NewWorkload(n int) *Workload {
	r := w.rng
	wl := &Workload{
		SpawnMean: 20 * time.Second, MaxLife: 20 * time.Minute, MaxLooks: 40,
		ExportP: 0.15, KillP: 0.03, GoRunP: 0.05, LongP: 0.05,
		HotSize: n / 5, Drift: 40 * time.Minute,
	}
	empty := sha256.Sum256(nil)
	for i := 0; i < n; i++ {
		a := &Action{}
		r.Read(a.ID[:])
		r.Read(a.Out[:])
		switch p := r.Float64(); {
		case p < 0.05:
			a.Kind, a.Out, a.Size = Empty, empty, 0
		case p < 0.15:
			a.Kind, a.Size = TestLog, int64(1000+r.Intn(50_000))
		case p < 0.18:
			a.Kind, a.Size = Exec, logUniform(r.Float64(), 5e6, 3e8)
		default:
			a.Kind, a.Size = Archive, logUniform(r.Float64(), 2e3, 2.5e8)
			if i > 0 && r.Float64() < 0.05 {
				prev := wl.Actions[r.Intn(len(wl.Actions))]
				if prev.Kind == Archive {
					a.Out, a.Size = prev.Out, prev.Size // a shared output
				}
			}
		}
		wl.Actions = append(wl.Actions, a)
	}
	w.workload = wl
	return wl
}

// NewAction makes one action of kind and size, for scenario fixtures.
func (w *World) NewAction(kind ActKind, size int64) *Action {
	a := &Action{Kind: kind, Size: size}
	w.rng.Read(a.ID[:])
	w.rng.Read(a.Out[:])
	if kind == Empty {
		a.Out, a.Size = sha256.Sum256(nil), 0
	}
	return a
}

// Kill ends p now, the way SIGKILL would.
func (w *World) Kill(p *Proc) { w.exit(p) }

// Rels are a's -a and output paths (an executable's file inside its dir).
func (a *Action) Rels() (action, output string) {
	action, output = cachefs.EntryRel(a.ID, cachefs.KindAction), cachefs.EntryRel(a.Out, cachefs.KindOutput)
	if a.Kind == Exec {
		output += "/prog"
	}
	return action, output
}

func logUniform(u, lo, hi float64) int64 {
	return int64(math.Exp(math.Log(lo) + u*(math.Log(hi)-math.Log(lo))))
}

// pick draws an action from the drifting hot set, Zipf-like.
func (wl *Workload) pick(w *World) *Action {
	n := len(wl.Actions)
	k := int(float64(wl.HotSize) * math.Pow(w.rng.Float64(), 2.5))
	if w.rng.Float64() < 0.1 {
		k = w.rng.Intn(n)
	}
	return wl.Actions[(wl.hot+k)%n]
}

// Start schedules go commands until awake time until.
func (w *World) Start(wl *Workload, until time.Duration) {
	var spawn func()
	spawn = func() {
		if w.mono >= until {
			return
		}
		w.spawnRandom(wl)
		w.After(time.Duration(w.rng.ExpFloat64()*float64(wl.SpawnMean)), spawn)
	}
	var drift func()
	drift = func() {
		if w.mono >= until {
			return
		}
		wl.hot = (wl.hot + wl.HotSize/2) % len(wl.Actions)
		w.After(wl.Drift, drift)
	}
	w.After(0, spawn)
	w.After(wl.Drift, drift)
}

// Populate creates entries for n actions, last used between 0 and maxAge
// ago (awake time equals wall time before the run).
func (w *World) Populate(wl *Workload, n int, maxAge time.Duration) {
	for i := 0; i < n && i < len(wl.Actions); i++ {
		a := wl.Actions[(wl.hot+len(wl.Actions)-n/2+i)%len(wl.Actions)]
		age := time.Duration(w.rng.Int63n(int64(maxAge) + 1))
		w.Place(a, age)
	}
}

// Place writes a's output and -a as if put age ago.
func (w *World) Place(a *Action, age time.Duration) {
	out := a.Out
	if a.Kind == TestLog {
		w.rng.Read(out[:])
	}
	w.writeOutput(a, out)
	w.writeAction(a, out)
	for _, f := range []*file{w.lookup(a.ID, cachefs.KindAction), w.lookup(out, cachefs.KindOutput)} {
		if f == nil {
			continue
		}
		w.age(f, age)
		if f.inner != nil {
			w.age(f.inner, age)
		}
	}
}

func (w *World) age(f *file, age time.Duration) {
	t := w.WallNs() - int64(age)
	f.mtime, f.atime, f.useMono, f.recMono, f.written = t, t, w.mono-age, w.mono-age, w.mono-age
}

func (w *World) writeOutput(a *Action, out [32]byte) {
	b := w.bucketOf(out)
	w.touchBucket(b)
	name := entryName(out, cachefs.KindOutput)
	now := w.WallNs()
	if old := b.files[name]; old != nil {
		w.release(old.totalAlloc())
	}
	f := &file{size: a.Size, alloc: alloc4k(a.Size), mtime: now, atime: now, useMono: w.mono, recMono: w.mono, ino: w.fs.newIno()}
	if a.Kind == Exec {
		inner := f
		f = &file{dir: true, mtime: now, atime: now, useMono: w.mono, recMono: w.mono, ino: w.fs.newIno(), inner: inner, innerName: "prog"}
	}
	b.files[name] = f
	w.addUsed(f.totalAlloc())
}

func (w *World) writeAction(a *Action, out [32]byte) {
	b := w.bucketOf(a.ID)
	name := entryName(a.ID, cachefs.KindAction)
	f := b.files[name]
	if f == nil || !b.present {
		w.touchBucket(b)
		f = &file{size: 179, alloc: 4096, ino: w.fs.newIno()}
		b.files[name] = f
		w.addUsed(f.alloc)
	}
	now := w.WallNs()
	f.out, f.mtime, f.atime, f.useMono, f.recMono, f.written, f.content = out, now, now, w.mono, w.mono, w.mono, nil
}

// --- go processes ---

// Proc is a simulated process.
type Proc struct {
	PID, PPID int32
	Start     int64
	Comm      string
	kind      string
	life      time.Duration
	begin     time.Duration
	end       time.Duration
	readsEnd  time.Duration // a go run stops reading the cache once its program runs
	export    bool
	held      []held
	dead      bool
}

type held struct {
	rel  string
	at   time.Duration
	race bool // an export put found its output gone (the documented race)
}

// ProcSpec describes a process for scenario tests.
type ProcSpec struct {
	Comm   string
	Kind   string
	Life   time.Duration
	Export bool
	Child  string // a child process name, "" for none
}

// Spawn starts a process now and returns it.
func (w *World) Spawn(s ProcSpec) *Proc {
	w.pidSeq++
	p := &Proc{PID: w.pidSeq, PPID: 1, Start: w.WallNs(), Comm: s.Comm, kind: s.Kind, life: s.Life, begin: w.mono, end: w.mono + s.Life, export: s.Export}
	p.readsEnd = p.end
	if s.Kind == "gorun" {
		// Build, link and exec take minutes; a removed binary keeps running.
		p.readsEnd = min(p.end, p.begin+12*time.Minute)
	}
	w.procs[p.PID] = p
	if s.Child != "" {
		w.pidSeq++
		c := &Proc{PID: w.pidSeq, PPID: p.PID, Start: w.WallNs(), Comm: s.Child, kind: "child", life: s.Life, begin: w.mono, end: p.end}
		w.procs[c.PID] = c
		w.At(c.end, func() { w.exit(c) })
	}
	w.At(p.end, func() { w.exit(p) })
	return p
}

func (w *World) exit(p *Proc) {
	if p.dead {
		return
	}
	p.dead = true
	delete(w.procs, p.PID)
	if p.export && p.kind != "reader" && len(p.held) > 0 {
		w.spawnReader(p)
	}
}

func (w *World) spawnRandom(wl *Workload) {
	r := w.rng
	spec := ProcSpec{Comm: "go", Kind: "build", Life: time.Duration(r.Int63n(int64(wl.MaxLife))) + time.Second}
	switch u := r.Float64(); {
	case u < wl.GoRunP:
		spec.Kind, spec.Child, spec.Life = "gorun", "server", spec.Life*6
	case u < wl.GoRunP+wl.LongP:
		spec.Kind, spec.Child, spec.Life = "longtest", "pkg.test", spec.Life*4
	case u < wl.GoRunP+wl.LongP+wl.ExportP:
		spec.Kind, spec.Export = "list", true
	}
	p := w.Spawn(spec)
	looks := 1 + r.Intn(wl.MaxLooks)
	span := p.life * 6 / 10
	if spec.Kind == "gorun" || spec.Kind == "longtest" {
		span = min(span, 10*time.Minute)
	}
	for i := 0; i < looks; i++ {
		a := wl.pick(w)
		w.After(time.Duration(r.Int63n(int64(span)+1)), func() { w.get(p, a, wl) })
	}
}

// Lookup makes p look a up now (scenario tests).
func (w *World) Lookup(p *Proc, a *Action) { w.get(p, a, w.workload) }

// get is cache.go's get (read -a, markUsed) then OutputFile (markUsed -d)
// and the size check, as two steps other work can interleave with.
func (w *World) get(p *Proc, a *Action, wl *Workload) {
	if p.dead {
		return
	}
	af := w.lookup(a.ID, cachefs.KindAction)
	if af == nil || af.special != 0 || af.content != nil {
		w.compile(p, a, wl)
		return
	}
	w.read(af)
	w.markUsed(af)
	out := af.out
	w.After(30*time.Microsecond, func() {
		if p.dead {
			return
		}
		d := w.lookup(out, cachefs.KindOutput)
		if d == nil || d.special != 0 {
			w.compile(p, a, wl)
			return
		}
		w.markUsed(d)
		rel := cachefs.EntryRel(out, cachefs.KindOutput)
		if d.dir {
			if d.inner == nil {
				w.compile(p, a, wl)
				return
			}
			rel += "/" + d.innerName
		} else if d.size != a.Size && a.Kind != TestLog {
			w.compile(p, a, wl)
			return
		}
		w.hold(p, rel, false)
	})
}

func (w *World) compile(p *Proc, a *Action, wl *Workload) {
	d := time.Duration(0.5*float64(time.Second) + float64(a.Size)/50e6*float64(time.Second))
	w.After(min(d, time.Minute), func() { w.put(p, a, wl) })
}

// put is cache.go's put: copyFile (verify an existing output without
// touching its mtime, or write it), then putIndexEntry; an export build then
// calls OutputFile on it.
func (w *World) put(p *Proc, a *Action, wl *Workload) {
	if p.dead {
		return
	}
	out := a.Out
	if a.Kind == TestLog {
		w.rng.Read(out[:])
	}
	gap := 50 * time.Microsecond
	if d := w.lookup(out, cachefs.KindOutput); d != nil && d.special == 0 && (d.dir || d.size == a.Size) {
		if d.dir && d.inner != nil {
			w.read(d.inner)
		} else if !d.dir {
			w.read(d)
		}
		gap += time.Duration(float64(a.Size) / 1e9 * float64(time.Second)) // the hash pass
	} else {
		w.writeOutput(a, out)
		gap += time.Duration(float64(a.Size) / 3e8 * float64(time.Second))
	}
	if wl != nil && w.rng.Float64() < wl.KillP {
		w.exit(p) // a memory brake kills it between the output and its -a
		return
	}
	w.After(gap, func() {
		if p.dead {
			return
		}
		w.writeAction(a, out)
		if p.export {
			d := w.lookup(out, cachefs.KindOutput)
			rel := cachefs.EntryRel(out, cachefs.KindOutput)
			if d == nil {
				p.held = append(p.held, held{rel: rel, at: w.mono, race: true})
				w.useLater(p, len(p.held)-1)
				return
			}
			w.markUsed(d)
			if d.dir && d.inner != nil {
				rel += "/" + d.innerName
			}
			w.hold(p, rel, false)
		}
	})
}

func (w *World) hold(p *Proc, rel string, race bool) {
	p.held = append(p.held, held{rel: rel, at: w.mono, race: race})
	w.useLater(p, len(p.held)-1)
}

// useLater reads a held path once or twice before the process ends, the way
// a link reads archives long after their lookup.
func (w *World) useLater(p *Proc, i int) {
	left := p.readsEnd - w.mono
	if left <= 0 {
		return
	}
	for k := 0; k < 1+w.rng.Intn(2); k++ {
		w.After(time.Duration(w.rng.Int63n(int64(left)))+1, func() { w.use(p, p.held[i]) })
	}
	w.At(p.readsEnd-1, func() { w.use(p, p.held[i]) })
}

// UseAt makes p read rel at awake time t (scenario tests).
func (w *World) UseAt(p *Proc, rel string, t time.Duration) {
	h := held{rel: rel, at: w.mono}
	w.At(t, func() { w.use(p, h) })
}

func (w *World) use(p *Proc, h held) {
	if p.dead && p.kind != "reader" {
		return
	}
	_, f, in, err := w.resolve(h.rel)
	if err == nil {
		if in != nil {
			w.read(in)
		} else if f != nil && !f.dir {
			w.read(f)
		}
		return
	}
	class := ""
	if h.race {
		class = "concurrent-put"
	}
	_, removed := w.removedAt[h.rel]
	w.Failures = append(w.Failures, Failure{
		Rel: h.rel, Kind: p.kind, Life: p.life, HeldFor: w.mono - h.at, Class: class, At: w.mono,
		Proc: p.PID, Removed: removed, Acquired: h.at,
	})
}

// spawnReader is golangci-lint or staticcheck reading export data after
// `go list -export` exited, at +5, +30 and +45 minutes.
func (w *World) spawnReader(src *Proc) {
	comm := "staticcheck"
	if w.rng.Intn(2) == 0 {
		comm = "golangci-lint"
	}
	r := w.Spawn(ProcSpec{Comm: comm, Kind: "reader", Life: 46 * time.Minute})
	hs := append([]held(nil), src.held...)
	for _, at := range []time.Duration{5 * time.Minute, 30 * time.Minute, 45 * time.Minute} {
		for _, h := range hs {
			w.After(at, func() { w.use(r, h) })
		}
	}
}

// Live is the number of live processes.
func (w *World) Live() int { return len(w.procs) }
