// Package index keeps the daemon's picture of a GOCACHE directory: every
// managed -a and -d entry with its lstat, which output each -a references, and
// how many -a reference each output. It is only a planning aid: every removal
// re-checks the file on disk first, so a stale index can skip an eviction but
// never cause an unsafe one.
package index

import (
	"encoding/hex"
	"strings"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

// ID is an action or output hash.
type ID = [32]byte

// Shape of an -d entry.
type Shape uint8

const (
	ShapeFile     Shape = iota // a regular output file
	ShapeExec                  // a directory holding one executable (go run, go tool)
	ShapeEmptyDir              // an executable directory left empty (a crash between unlink and rmdir)
)

type aRec struct {
	st     cachefs.Stat
	out    ID
	hasOut bool
	gen    uint32
	stuck  int64 // wall ns until which a refused removal is not retried
}

type dRec struct {
	st      cachefs.Stat
	shape   Shape
	inner   string
	innerSt cachefs.Stat
	gen     uint32
	stuck   int64
}

// bytes is what removing the output gives back.
func (d *dRec) bytes() int64 {
	if d.shape == ShapeExec {
		return d.st.Alloc + d.innerSt.Alloc
	}
	return d.st.Alloc
}

// recency is the newest use of the output. A directory's own atime is left
// out: the daemon's listing of it would bump it.
func (d *dRec) recency() int64 {
	switch d.shape {
	case ShapeExec:
		return max(d.st.Mtime, d.innerSt.Recency())
	case ShapeEmptyDir:
		return d.st.Mtime
	}
	return d.st.Recency()
}

type bucket struct {
	present   bool
	listed    bool
	dirty     bool
	dirIno    uint64
	dirMtime  int64
	a         map[ID]*aRec
	d         map[ID]*dRec
	refs      map[ID]int32 // -a references into outputs of this bucket
	unmanaged map[string]*unmRec
	temps     map[string]*tempRec
}

type tempRec struct {
	st  cachefs.Stat
	pid int
	gen uint32
}

type unmRec struct {
	alloc int64
	gen   uint32
}

// Counters count filesystem calls, so status can show the scan cost.
type Counters struct {
	Lstats  uint64
	Reads   uint64
	Lists   uint64
	Relists uint64
}

// Index is not safe for concurrent use; the daemon loop owns it.
type Index struct {
	fs         cachefs.FS
	b          [256]bucket
	listed     int // buckets listed at least once since the last reset
	cursor     int // next bucket for RestatStep
	pollCursor int // next bucket for Poll
	gen        uint32
	rootIno    uint64
	rootOK     bool
	rootGen    uint32 // bumped whenever the root appears, vanishes or is replaced
	root       rootWalk
	size       int64
	actions    int
	outputs    int
	unmBytes   int64
	unmCount   int
	tmpBytes   int64
	tmpCount   int
	// Added counts bytes of entries that appeared after the first full index:
	// what go wrote while the daemon watched.
	Added int64
	// Vanished counts bytes of entries that disappeared without the daemon
	// removing them (go clean -cache, another deleter).
	Vanished int64
	Counters Counters
}

// New returns an empty index over fsys.
func New(fsys cachefs.FS) *Index {
	x := &Index{fs: fsys}
	x.resetBuckets()
	return x
}

func (x *Index) resetBuckets() {
	for i := range x.b {
		x.b[i] = bucket{
			a:         map[ID]*aRec{},
			d:         map[ID]*dRec{},
			refs:      map[ID]int32{},
			unmanaged: map[string]*unmRec{},
			temps:     map[string]*tempRec{},
		}
	}
	x.listed, x.cursor = 0, 0
	x.size, x.actions, x.outputs, x.unmBytes, x.unmCount = 0, 0, 0, 0, 0
	x.tmpBytes, x.tmpCount = 0, 0
}

// Complete reports whether every bucket has been listed since the cache
// directory appeared. Refcounts are only trusted then.
func (x *Index) Complete() bool { return x.rootOK && x.listed == 256 }

// Progress is how many of the 256 buckets have been listed.
func (x *Index) Progress() int { return x.listed }

// RootOK reports whether the cache directory exists.
func (x *Index) RootOK() bool { return x.rootOK }

func (x *Index) Size() int64            { return x.size }
func (x *Index) Actions() int           { return x.actions }
func (x *Index) Outputs() int           { return x.outputs }
func (x *Index) UnmanagedBytes() int64  { return x.unmBytes }
func (x *Index) UnmanagedCount() int    { return x.unmCount }
func (x *Index) Entries() int           { return x.actions + x.outputs }
func (x *Index) bucketOf(id ID) *bucket { return &x.b[id[0]] }

// checkRoot follows the cache directory appearing, vanishing or being
// replaced; a replaced root starts the index over.
func (x *Index) checkRoot() bool {
	st, err := x.fs.Lstat("")
	x.Counters.Lstats++
	ok := err == nil && st.Type == cachefs.Dir
	switch {
	case !ok:
		if x.rootOK {
			x.Vanished += x.size
			x.resetBuckets()
			x.rootGen++
		}
		x.rootOK, x.rootIno = false, 0
	case !x.rootOK || st.Ino != x.rootIno:
		if x.rootOK {
			x.Vanished += x.size
		}
		x.resetBuckets()
		x.rootOK, x.rootIno = true, st.Ino
		x.rootGen++
	}
	return ok
}

// RootGen changes whenever the cache directory appears, vanishes or is
// replaced by another directory.
func (x *Index) RootGen() uint32 { return x.rootGen }

// CheckRoot looks at the cache directory now (one lstat).
func (x *Index) CheckRoot() bool { return x.checkRoot() }

// IndexStep lists buckets not yet listed, at least one, while more allows.
// It returns true when the index is complete.
func (x *Index) IndexStep(more func() bool) bool {
	if !x.checkRoot() {
		return false
	}
	for i := 0; i < 256; i++ {
		if !x.b[i].listed {
			x.list(i, true)
			if !more() {
				break
			}
		}
	}
	return x.Complete()
}

// Poll lstat's the bucket directories, resuming where the last call stopped,
// and marks the changed ones dirty. It returns true when this call made a
// full round.
func (x *Index) Poll(more func() bool) bool {
	if !x.checkRoot() {
		return false
	}
	for n := 1; n <= 256; n++ {
		i := x.pollCursor
		x.pollCursor = (i + 1) % 256
		bk := &x.b[i]
		st, err := x.fs.Lstat(cachefs.BucketName(i))
		x.Counters.Lstats++
		present := err == nil && st.Type == cachefs.Dir
		if present != bk.present || (present && (st.Ino != bk.dirIno || st.Mtime != bk.dirMtime)) || !bk.listed {
			bk.dirty = true
		}
		if n < 256 && !more() {
			return false
		}
	}
	return true
}

// RelistDirty relists dirty buckets while more allows: new names are stat'ed
// and parsed, vanished names dropped, existing entries not re-stat'ed. It
// returns true when no dirty bucket is left.
func (x *Index) RelistDirty(more func() bool) bool {
	if !x.rootOK {
		return false
	}
	stopped := false
	for i := range x.b {
		if !x.b[i].dirty {
			continue
		}
		if stopped {
			return false
		}
		x.list(i, false)
		stopped = !more()
	}
	return true
}

// RestatStep re-stats every entry of up to n buckets (at least one), catching
// mtime refreshes and -a files rewritten in place. It returns how many
// buckets it did.
func (x *Index) RestatStep(n int, more func() bool) int {
	if n <= 0 || !x.checkRoot() {
		return 0
	}
	done := 0
	for done < n {
		x.list(x.cursor, true)
		x.cursor = (x.cursor + 1) % 256
		done++
		if !more() {
			break
		}
	}
	return done
}

func (x *Index) list(i int, restat bool) {
	bk := &x.b[i]
	rel := cachefs.BucketName(i)
	st, err := x.fs.Lstat(rel)
	x.Counters.Lstats++
	if err != nil || st.Type != cachefs.Dir {
		x.dropBucket(i, true)
		bk.present, bk.dirty = false, false
		x.markListed(bk)
		return
	}
	if bk.present && bk.dirIno != st.Ino {
		x.dropBucket(i, true)
	}
	names, err := x.fs.ReadDirNames(rel)
	x.Counters.Lists++
	if bk.listed {
		x.Counters.Relists++
	}
	if err != nil && len(names) == 0 {
		// Unreadable now (EACCES, a race with removal): keep what we know.
		bk.dirty = true
		return
	}
	x.gen++
	gen := x.gen
	initial := !bk.listed
	for _, name := range names {
		id, kind, ok := cachefs.ParseEntryName(i, name)
		if !ok {
			if pid, _, isTemp := store.ParseTempName(name); isTemp {
				x.noteTemp(bk, rel+"/"+name, name, int(pid), gen, restat || initial)
			} else {
				x.noteUnmanaged(bk, rel+"/"+name, name, gen, restat || initial)
			}
			continue
		}
		if kind == cachefs.KindAction {
			x.seeAction(bk, id, rel+"/"+name, gen, restat || initial)
		} else {
			x.seeOutput(bk, id, rel+"/"+name, gen, restat || initial)
		}
	}
	for id, r := range bk.a {
		if r.gen != gen {
			x.Vanished += r.st.Alloc
			x.dropAction(id)
		}
	}
	for id, r := range bk.d {
		if r.gen != gen {
			x.Vanished += r.bytes()
			x.dropOutput(id)
		}
	}
	for name, u := range bk.unmanaged {
		if u.gen != gen {
			x.unmBytes -= u.alloc
			x.unmCount--
			delete(bk.unmanaged, name)
		}
	}
	for name, t := range bk.temps {
		if t.gen != gen {
			x.dropTemp(bk, name)
		}
	}
	bk.present, bk.dirIno, bk.dirMtime, bk.dirty = true, st.Ino, st.Mtime, false
	x.markListed(bk)
}

func (x *Index) markListed(bk *bucket) {
	if !bk.listed {
		bk.listed = true
		x.listed++
	}
}

// noteTemp records a client temp file; restat refreshes its mtime.
func (x *Index) noteTemp(bk *bucket, rel, name string, pid int, gen uint32, stat bool) {
	t := bk.temps[name]
	if t != nil && !stat {
		t.gen = gen
		return
	}
	st, err := x.fs.Lstat(rel)
	x.Counters.Lstats++
	if err != nil || st.Type != cachefs.Regular {
		if t != nil {
			x.dropTemp(bk, name)
		}
		if err == nil {
			x.noteUnmanaged(bk, rel, name, gen, true)
		}
		return
	}
	if t == nil {
		t = &tempRec{}
		bk.temps[name] = t
		x.tmpCount++
	}
	x.tmpBytes += st.Alloc - t.st.Alloc
	t.st, t.pid, t.gen = st, pid, gen
}

func (x *Index) dropTemp(bk *bucket, name string) {
	if t := bk.temps[name]; t != nil {
		x.tmpBytes -= t.st.Alloc
		x.tmpCount--
		delete(bk.temps, name)
	}
}

// noteUnmanaged records a name the daemon never touches, for status.
func (x *Index) noteUnmanaged(bk *bucket, rel, name string, gen uint32, stat bool) {
	u := bk.unmanaged[name]
	if u != nil && !stat {
		u.gen = gen
		return
	}
	var alloc int64
	if st, err := x.fs.Lstat(rel); err == nil {
		alloc = st.Alloc
	}
	x.Counters.Lstats++
	if u == nil {
		u = &unmRec{}
		bk.unmanaged[name] = u
		x.unmCount++
	}
	x.unmBytes += alloc - u.alloc
	u.alloc, u.gen = alloc, gen
}

func (x *Index) seeAction(bk *bucket, id ID, rel string, gen uint32, restat bool) {
	r := bk.a[id]
	if r != nil && !restat {
		r.gen = gen
		return
	}
	st, err := x.fs.Lstat(rel)
	x.Counters.Lstats++
	if err != nil {
		return // vanished between listing and stat: the sweep drops it
	}
	if st.Type != cachefs.Regular {
		// A directory, FIFO or symlink named like an entry is never touched.
		if r != nil {
			x.dropAction(id)
		}
		x.noteUnmanaged(bk, rel, rel[3:], gen, true)
		return
	}
	if r != nil && r.st.Ino == st.Ino && r.st.Mtime == st.Mtime && r.st.Size == st.Size {
		x.size += st.Alloc - r.st.Alloc
		r.st, r.gen = st, gen
		return
	}
	out, hasOut := x.readRef(rel)
	if r == nil {
		r = &aRec{}
		bk.a[id] = r
		x.actions++
		if x.Complete() {
			x.Added += st.Alloc
		}
	} else {
		x.size -= r.st.Alloc
		if r.hasOut {
			x.unref(r.out)
		}
	}
	r.st, r.out, r.hasOut, r.gen, r.stuck = st, out, hasOut, gen, 0
	x.size += st.Alloc
	if hasOut {
		x.bucketOf(out).refs[out]++
	}
}

func (x *Index) seeOutput(bk *bucket, id ID, rel string, gen uint32, restat bool) {
	r := bk.d[id]
	if r != nil && !restat {
		r.gen = gen
		return
	}
	st, err := x.fs.Lstat(rel)
	x.Counters.Lstats++
	if err != nil {
		return
	}
	nr := dRec{st: st, gen: gen}
	switch st.Type {
	case cachefs.Regular:
		nr.shape = ShapeFile
	case cachefs.Dir:
		names, err := x.fs.ReadDirNames(rel)
		x.Counters.Lists++
		switch {
		case err != nil:
			return
		case len(names) == 0:
			nr.shape = ShapeEmptyDir
		case len(names) == 1:
			ist, err := x.fs.Lstat(rel + "/" + names[0])
			x.Counters.Lstats++
			if err != nil || ist.Type != cachefs.Regular {
				x.unmanagedOutput(bk, id, rel, gen)
				return
			}
			nr.shape, nr.inner, nr.innerSt = ShapeExec, names[0], ist
		default:
			// Go itself treats this as an invalid entry; leave it alone.
			x.unmanagedOutput(bk, id, rel, gen)
			return
		}
	default:
		x.unmanagedOutput(bk, id, rel, gen)
		return
	}
	if r == nil {
		r = &dRec{}
		bk.d[id] = r
		x.outputs++
		if x.Complete() {
			x.Added += nr.bytes()
		}
	} else {
		x.size -= r.bytes()
	}
	stuck := r.stuck
	if r.st.Ino != st.Ino || r.st.Mtime != st.Mtime {
		stuck = 0
	}
	*r = nr
	r.stuck = stuck
	x.size += r.bytes()
}

func (x *Index) unmanagedOutput(bk *bucket, id ID, rel string, gen uint32) {
	if bk.d[id] != nil {
		x.dropOutput(id)
	}
	x.noteUnmanaged(bk, rel, rel[3:], gen, true)
}

// readRef extracts the output ID an -a file references. It is deliberately
// lenient (only the header and the output hex must parse): treating a file go
// would reject as a reference protects its output longer, never shorter.
func (x *Index) readRef(rel string) (ID, bool) {
	var buf [entryLen + 1]byte
	n, _ := x.fs.ReadPrefix(rel, buf[:])
	x.Counters.Reads++
	return parseRef(buf[:n])
}

// entryLen is cache.go's entrySize: "v1 <64> <64> <20> <20>\n".
const entryLen = 2 + 1 + 64 + 1 + 64 + 1 + 20 + 1 + 20 + 1

func parseRef(b []byte) (ID, bool) {
	var out ID
	if len(b) < 3+64+1+64 || b[0] != 'v' || b[1] != '1' || b[2] != ' ' || b[67] != ' ' {
		return out, false
	}
	if len(b) > 132 && b[132] != ' ' {
		return out, false
	}
	for _, c := range b[68:132] {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return out, false
		}
	}
	if _, err := hex.Decode(out[:], b[68:132]); err != nil {
		return out, false
	}
	return out, true
}

func (x *Index) unref(out ID) {
	ob := x.bucketOf(out)
	if n := ob.refs[out] - 1; n > 0 {
		ob.refs[out] = n
	} else {
		delete(ob.refs, out)
	}
}

func (x *Index) dropAction(id ID) {
	bk := x.bucketOf(id)
	r := bk.a[id]
	if r == nil {
		return
	}
	if r.hasOut {
		x.unref(r.out)
	}
	x.size -= r.st.Alloc
	x.actions--
	delete(bk.a, id)
}

func (x *Index) dropOutput(id ID) {
	bk := x.bucketOf(id)
	r := bk.d[id]
	if r == nil {
		return
	}
	x.size -= r.bytes()
	x.outputs--
	delete(bk.d, id)
}

func (x *Index) dropBucket(i int, vanished bool) {
	bk := &x.b[i]
	for id, r := range bk.a {
		if vanished {
			x.Vanished += r.st.Alloc
		}
		x.dropAction(id)
	}
	for id, r := range bk.d {
		if vanished {
			x.Vanished += r.bytes()
		}
		x.dropOutput(id)
	}
	for name, u := range bk.unmanaged {
		x.unmBytes -= u.alloc
		x.unmCount--
		delete(bk.unmanaged, name)
	}
	for name := range bk.temps {
		x.dropTemp(bk, name)
	}
}

// rootWalk counts what lies at the cache root besides the buckets (fuzz/,
// README, trim.txt, strays), never following a symlink. It resumes across
// calls; totals are published when a walk ends.
type rootWalk struct {
	running bool
	gen     uint32
	stack   []string
	bytes   int64
	fuzz    int64
	files   int

	done  bool
	Bytes int64
	Fuzz  int64
	Files int
}

// WalkRoot advances the root walk by whole directories while more allows; it
// returns true when a walk finished in this call. The next call starts over.
func (x *Index) WalkRoot(more func() bool) bool {
	w := &x.root
	if !w.running || w.gen != x.rootGen {
		w.running, w.gen, w.stack = true, x.rootGen, append(w.stack[:0], "")
		w.bytes, w.fuzz, w.files = 0, 0, 0
	}
	for len(w.stack) > 0 {
		dir := w.stack[len(w.stack)-1]
		w.stack = w.stack[:len(w.stack)-1]
		names, err := x.fs.ReadDirNames(dir)
		x.Counters.Lists++
		if err != nil && len(names) == 0 && dir == "" {
			w.running = false
			return false
		}
		for _, name := range names {
			rel := name
			if dir != "" {
				rel = dir + "/" + name
			}
			st, err := x.fs.Lstat(rel)
			x.Counters.Lstats++
			if err != nil {
				continue
			}
			if _, bucket := cachefs.ParseBucketName(name); bucket && dir == "" && st.Type == cachefs.Dir {
				continue
			}
			w.bytes += st.Alloc
			if rel == "fuzz" || strings.HasPrefix(rel, "fuzz/") {
				w.fuzz += st.Alloc
			}
			if st.Type == cachefs.Dir {
				w.stack = append(w.stack, rel)
			} else {
				w.files++
			}
		}
		if len(w.stack) > 0 && !more() {
			return false
		}
	}
	w.running, w.done = false, true
	w.Bytes, w.Fuzz, w.Files = w.bytes, w.fuzz, w.files
	return true
}

// RootUnmanaged is the last finished root walk: bytes and files at the root
// besides the buckets, and the fuzz/ part. ok is false before the first one.
func (x *Index) RootUnmanaged() (bytes, fuzz int64, files int, ok bool) {
	return x.root.Bytes, x.root.Fuzz, x.root.Files, x.root.done
}
