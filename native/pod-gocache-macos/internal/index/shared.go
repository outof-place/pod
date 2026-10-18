package index

import (
	"errors"
	"io/fs"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
)

// Exact is an -a entry as go would accept it, with the stat that identifies
// that content: while the file keeps this inode and ctime it says the same.
type Exact struct {
	Out          ID
	Size, Time   int64
	Ino          uint64
	Ctime, Mtime int64
}

// ActionEntry returns id's entry when it was read exactly.
func (x *Index) ActionEntry(id ID) (Exact, bool) {
	r := x.bucketOf(id).a[id]
	if r == nil || !r.exact {
		return Exact{}, false
	}
	return Exact{Out: r.out, Size: r.size, Time: r.time, Ino: r.st.Ino, Ctime: r.st.Ctime, Mtime: r.st.Mtime}, true
}

// TakeChanged calls fn for every -a whose record changed or went away since
// the last call, and forgets them.
func (x *Index) TakeChanged(fn func(id ID)) {
	for id := range x.changed {
		fn(id)
	}
	clear(x.changed)
}

// EachExact calls fn for every exactly read -a.
func (x *Index) EachExact(fn func(id ID, e Exact)) {
	for i := range x.b {
		for id, r := range x.b[i].a {
			if r.exact {
				fn(id, Exact{Out: r.out, Size: r.size, Time: r.time, Ino: r.st.Ino, Ctime: r.st.Ctime, Mtime: r.st.Mtime})
			}
		}
	}
}

func prefixOf(id *ID) uint64 {
	var v uint64
	for j := range 8 {
		v |= uint64(id[j]) << (8 * j)
	}
	return v
}

// Prefix is the first 8 bytes of id, little-endian: what clients log.
func Prefix(id ID) uint64 { return prefixOf(&id) }

// ActionsWithPrefix calls fn for every indexed -a whose ID starts with p (its
// bucket is p's low byte). ok is false when that bucket was never listed.
func (x *Index) ActionsWithPrefix(p uint64, fn func(id ID)) (listed bool) {
	bk := &x.b[byte(p)]
	for id := range bk.a {
		if prefixOf(&id) == p {
			fn(id)
		}
	}
	return bk.listed
}

// OutputsWithPrefix calls fn for every indexed output whose ID starts with p,
// with the bytes removing it gives back.
func (x *Index) OutputsWithPrefix(p uint64, fn func(id ID, bytes int64)) {
	bk := &x.b[byte(p)]
	for id, r := range bk.d {
		if prefixOf(&id) == p {
			fn(id, r.bytes())
		}
	}
}

// Reread looks at one -a now, because a client found it different from what
// the index published: a changed file is re-read, a vanished one dropped. An
// ID the index has never seen makes its bucket dirty, so the next relist
// finds the new name.
func (x *Index) Reread(id ID) {
	if !x.rootOK {
		return
	}
	bk := x.bucketOf(id)
	r := bk.a[id]
	if r == nil {
		bk.dirty = true
		return
	}
	rel := cachefs.EntryRel(id, cachefs.KindAction)
	_, err := x.fs.Lstat(rel)
	x.Counters.Lstats++
	if errors.Is(err, fs.ErrNotExist) {
		x.Vanished += r.st.Alloc
		x.dropAction(id)
		return
	}
	x.seeAction(bk, id, rel, r.gen, true)
}

// MarkBucketDirty makes the next RelistDirty list bucket i.
func (x *Index) MarkBucketDirty(i byte) { x.b[i].dirty = true }
