package index

import (
	"slices"
	"strings"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
)

// Unit is one eviction candidate: an -a with the output it references, or an
// output no -a references (an orphan). Times are wall unix nanoseconds.
type Unit struct {
	Orphan   bool
	ID       ID // the -a, or the output for an orphan
	Out      ID
	HasOut   bool  // the referenced output exists
	Refs     int32 // -a files referencing Out
	ABytes   int64
	DBytes   int64
	Recency  int64 // newest of the -a mtime and the output's recency
	Stuck    bool  // a removal was refused recently
	FutureAt int64 // the newest timestamp, when it lies in the future
}

// Bytes is what evicting the unit gives back when it holds the last reference.
func (u *Unit) Bytes(lastRef bool) int64 {
	if u.Orphan || (u.HasOut && lastRef) {
		return u.ABytes + u.DBytes
	}
	return u.ABytes
}

// Units appends every candidate to dst. Order follows map iteration; the
// planner sorts with a total order. Recency beyond futureLimit marks FutureAt.
func (x *Index) Units(dst []Unit, now, futureLimit int64) []Unit {
	for i := range x.b {
		bk := &x.b[i]
		for id, a := range bk.a {
			u := Unit{ID: id, ABytes: a.st.Alloc, Recency: a.st.Mtime, Stuck: a.stuck > now}
			if a.hasOut {
				u.Out = a.out
				ob := x.bucketOf(a.out)
				u.Refs = ob.refs[a.out]
				if d := ob.d[a.out]; d != nil {
					u.HasOut, u.DBytes = true, d.bytes()
					u.Recency = max(u.Recency, d.recency())
					u.Stuck = u.Stuck || d.stuck > now
				}
			}
			if u.Recency > futureLimit {
				u.FutureAt = u.Recency
			}
			dst = append(dst, u)
		}
		for id, d := range bk.d {
			if bk.refs[id] > 0 {
				continue
			}
			u := Unit{Orphan: true, ID: id, Out: id, HasOut: true, DBytes: d.bytes(), Recency: d.recency(), Stuck: d.stuck > now}
			if u.Recency > futureLimit {
				u.FutureAt = u.Recency
			}
			dst = append(dst, u)
		}
	}
	return dst
}

// ActionView is the current record of an -a.
type ActionView struct {
	Rel    string
	St     cachefs.Stat
	Out    ID
	HasOut bool
}

// OutputView is the current record of an output.
type OutputView struct {
	Rel     string
	St      cachefs.Stat
	Shape   Shape
	Inner   string // ShapeExec: the executable's name
	InnerSt cachefs.Stat
	Refs    int32
	Bytes   int64
	Recency int64
}

func (x *Index) Action(id ID) (ActionView, bool) {
	a := x.bucketOf(id).a[id]
	if a == nil {
		return ActionView{}, false
	}
	return ActionView{Rel: cachefs.EntryRel(id, cachefs.KindAction), St: a.st, Out: a.out, HasOut: a.hasOut}, true
}

func (x *Index) Output(id ID) (OutputView, bool) {
	bk := x.bucketOf(id)
	d := bk.d[id]
	if d == nil {
		return OutputView{Refs: bk.refs[id]}, false
	}
	return OutputView{
		Rel: cachefs.EntryRel(id, cachefs.KindOutput), St: d.st, Shape: d.shape, Inner: d.inner,
		InnerSt: d.innerSt, Refs: bk.refs[id], Bytes: d.bytes(), Recency: d.recency(),
	}, true
}

// Refs is how many -a files reference out.
func (x *Index) Refs(out ID) int32 { return x.bucketOf(out).refs[out] }

// RemovedAction records that the daemon unlinked an -a.
func (x *Index) RemovedAction(id ID) { x.dropAction(id) }

// RemovedOutput records that the daemon removed an output.
func (x *Index) RemovedOutput(id ID) { x.dropOutput(id) }

// OutputEmptied records that the daemon unlinked the executable inside an
// output directory but has not removed the directory yet.
func (x *Index) OutputEmptied(id ID, dirSt cachefs.Stat) {
	d := x.bucketOf(id).d[id]
	if d == nil {
		return
	}
	x.size -= d.bytes()
	d.shape, d.inner, d.innerSt, d.st = ShapeEmptyDir, "", cachefs.Stat{}, dirSt
	x.size += d.bytes()
}

// RefreshAction stores a newer stat seen while removing (the entry was in use).
func (x *Index) RefreshAction(id ID, st cachefs.Stat) {
	if a := x.bucketOf(id).a[id]; a != nil && st.Ino == a.st.Ino {
		x.size += st.Alloc - a.st.Alloc
		a.st = st
	}
}

// RefreshOutput stores a newer stat of an output file or its executable.
func (x *Index) RefreshOutput(id ID, st cachefs.Stat, inner bool) {
	d := x.bucketOf(id).d[id]
	if d == nil {
		return
	}
	x.size -= d.bytes()
	if inner {
		if st.Ino == d.innerSt.Ino {
			d.innerSt = st
		}
	} else if st.Ino == d.st.Ino {
		d.st = st
	}
	x.size += d.bytes()
}

// MarkStuck stops retrying a refused removal until wall time until.
func (x *Index) MarkStuck(id ID, kind byte, until int64) {
	bk := x.bucketOf(id)
	if kind == cachefs.KindAction {
		if a := bk.a[id]; a != nil {
			a.stuck = until
		}
	} else if d := bk.d[id]; d != nil {
		d.stuck = until
	}
}

// Forget drops an entry whose file turned out to be gone (deleted by someone
// else: counted in Vanished) or replaced; the next relist sees the truth.
func (x *Index) Forget(id ID, kind byte, gone bool) {
	bk := x.bucketOf(id)
	if kind == cachefs.KindAction {
		if a := bk.a[id]; a != nil && gone {
			x.Vanished += a.st.Alloc
		}
		x.dropAction(id)
	} else {
		if d := bk.d[id]; d != nil && gone {
			x.Vanished += d.bytes()
		}
		x.dropOutput(id)
	}
	bk.dirty = true
}

// MarkDirty forces a relist of id's bucket.
func (x *Index) MarkDirty(id ID) { x.bucketOf(id).dirty = true }

// Temp is a client temp file in a bucket.
type Temp struct {
	Rel string
	PID int
	St  cachefs.Stat
}

// Temps appends every client temp file, in bucket and name order.
func (x *Index) Temps(dst []Temp) []Temp {
	for i := range x.b {
		bk := &x.b[i]
		start := len(dst)
		for name, t := range bk.temps {
			dst = append(dst, Temp{Rel: cachefs.BucketName(i) + "/" + name, PID: t.pid, St: t.st})
		}
		slices.SortFunc(dst[start:], func(a, b Temp) int { return strings.Compare(a.Rel, b.Rel) })
	}
	return dst
}

// TempBytes is the allocated size of client temp files.
func (x *Index) TempBytes() int64 { return x.tmpBytes }

// RemovedTemp records that the daemon swept a temp file (or found it gone).
func (x *Index) RemovedTemp(rel string) {
	if b, ok := cachefs.ParseBucketName(rel[:2]); ok {
		x.dropTemp(&x.b[b], rel[3:])
	}
}
