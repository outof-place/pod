package cachesim

import (
	"fmt"
	"io/fs"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

const hourNs = int64(time.Hour)

type file struct {
	dir       bool // an executable -d directory
	inner     *file
	innerName string
	size      int64
	alloc     int64
	mtime     int64
	atime     int64
	useMono   time.Duration // awake time of the last use by a go process
	recMono   time.Duration // awake time its visible recency (mtime, atime) was last set
	ino       uint64
	ctime     int64 // moves on every write or time change, never repeats
	// -a files
	out     [32]byte
	content []byte // nil: a valid entry is formatted on read
	written time.Duration
	// test knobs
	refused bool
	special cachefs.Type // non-zero: a FIFO, symlink or dir named like an entry
}

func (f *file) recency() int64 {
	if f.dir {
		r := f.mtime
		if f.inner != nil {
			r = max(r, f.inner.recency())
		}
		return r
	}
	return max(f.mtime, f.atime)
}

func (f *file) totalAlloc() int64 {
	if f.dir && f.inner != nil {
		return f.alloc + f.inner.alloc
	}
	return f.alloc
}

// visibleAt is the awake time f's recency was last set (an -d dir counts its
// executable): what the rules measure the window from.
func (f *file) visibleAt() time.Duration {
	if f.dir && f.inner != nil {
		return max(f.recMono, f.inner.recMono)
	}
	return f.recMono
}

type bucket struct {
	present bool
	ino     uint64
	mtime   int64
	files   map[string]*file
}

type fsState struct {
	w           *World
	rootPresent bool
	rootIno     uint64
	b           [256]bucket
	nextIno     uint64
	ctime       int64 // the last ctime handed out
	trim        int64
	strays      map[string]int64 // root-level names that are not buckets
}

type diskState struct {
	capacity int64
	used     int64
	external int64
	pinned   int64 // bytes removed but not given back (snapshots)
	// FreeIgnoresRemovals keeps removed bytes in use (an APFS snapshot).
	FreeIgnoresRemovals bool
}

func (s *fsState) init(w *World) {
	s.w = w
	s.rootPresent, s.rootIno, s.nextIno = true, 1, 2
	s.strays = map[string]int64{}
	for i := range s.b {
		s.b[i] = bucket{present: true, ino: s.newIno(), files: map[string]*file{}}
	}
}

func (s *fsState) newIno() uint64 { s.nextIno++; return s.nextIno }

func alloc4k(n int64) int64 { return (n + 4095) &^ 4095 }

// --- placement helpers for go processes and fixtures ---

func (w *World) bucketOf(id [32]byte) *bucket { return &w.fs.b[id[0]] }

func entryName(id [32]byte, kind byte) string { return cachefs.EntryRel(id, kind)[3:] }

func (w *World) touchBucket(b *bucket) {
	if !b.present {
		// cmd/go recreates missing buckets (cache.Open's MkdirAll).
		b.present, b.ino, b.files = true, w.fs.newIno(), map[string]*file{}
	}
	b.mtime = w.WallNs()
}

func (w *World) addUsed(n int64) { w.disk.used += n }

func (w *World) lookup(id [32]byte, kind byte) *file {
	b := w.bucketOf(id)
	if !b.present || !w.fs.rootPresent {
		return nil
	}
	return b.files[entryName(id, kind)]
}

// markUsed is cmd/go's: refresh mtime and atime when mtime is an hour old.
func (w *World) markUsed(f *file) { w.markUsedReport(f) }

// markUsedReport is markUsed reporting whether it refreshed.
func (w *World) markUsedReport(f *file) bool {
	now := w.WallNs()
	f.useMono = w.mono
	if now-f.mtime >= hourNs {
		f.mtime, f.atime, f.recMono = now, now, w.mono
		w.changed(f)
		return true
	}
	return false
}

// changed moves f's ctime, as any write or utimes does on APFS (nanosecond
// clock: two changes never share a ctime).
func (w *World) changed(f *file) {
	w.fs.ctime = max(w.WallNs(), w.fs.ctime+1)
	f.ctime = w.fs.ctime
}

// read is a read(2): APFS bumps atime only when it is older than mtime.
func (w *World) read(f *file) {
	now := w.WallNs()
	if f.atime < f.mtime {
		f.atime = now
		f.recMono = w.mono
	}
	f.useMono = w.mono
}

// --- the daemon's filesystem ---

func split(rel string) (b int, name, inner string, ok bool) {
	if len(rel) < 2 {
		return 0, "", "", false
	}
	v, err := strconv.ParseUint(rel[:2], 16, 8)
	if err != nil || strings.ToLower(rel[:2]) != rel[:2] {
		return 0, "", "", false
	}
	rest := rel[2:]
	if rest == "" {
		return int(v), "", "", true
	}
	if rest[0] != '/' {
		return 0, "", "", false
	}
	name, inner, _ = strings.Cut(rest[1:], "/")
	return int(v), name, inner, true
}

func notExist(rel string) error {
	return &fs.PathError{Op: "lstat", Path: rel, Err: syscall.ENOENT}
}

func statOf(f *file) cachefs.Stat {
	st := cachefs.Stat{Type: cachefs.Regular, Size: f.size, Alloc: f.alloc, Mtime: f.mtime, Atime: f.atime, Ctime: f.ctime, Ino: f.ino}
	if f.dir {
		st.Type = cachefs.Dir
	}
	if f.special != 0 {
		st.Type = f.special
	}
	return st
}

func (w *World) resolve(rel string) (*bucket, *file, *file, error) {
	b, name, inner, ok := split(rel)
	if !ok || !w.fs.rootPresent {
		return nil, nil, nil, notExist(rel)
	}
	bk := &w.fs.b[b]
	if !bk.present {
		return nil, nil, nil, notExist(rel)
	}
	if name == "" {
		return bk, nil, nil, nil
	}
	f := bk.files[name]
	if f == nil {
		return bk, nil, nil, notExist(rel)
	}
	if inner == "" {
		return bk, f, nil, nil
	}
	if !f.dir || f.inner == nil || f.innerName != inner {
		return bk, f, nil, notExist(rel)
	}
	return bk, f, f.inner, nil
}

func (w *World) Lstat(rel string) (cachefs.Stat, error) {
	w.op()
	if rel == "" {
		if !w.fs.rootPresent {
			return cachefs.Stat{}, notExist(rel)
		}
		return cachefs.Stat{Type: cachefs.Dir, Ino: w.fs.rootIno}, nil
	}
	if _, ok := w.fs.strays[rel]; ok && w.fs.rootPresent {
		return cachefs.Stat{Type: cachefs.Regular, Alloc: w.fs.strays[rel]}, nil
	}
	bk, f, in, err := w.resolve(rel)
	if err != nil {
		return cachefs.Stat{}, err
	}
	switch {
	case in != nil:
		return statOf(in), nil
	case f != nil:
		return statOf(f), nil
	}
	return cachefs.Stat{Type: cachefs.Dir, Ino: bk.ino, Mtime: bk.mtime}, nil
}

func (w *World) ReadDirNames(rel string) ([]string, error) {
	w.op()
	if rel == "" {
		if !w.fs.rootPresent {
			return nil, notExist(rel)
		}
		var names []string
		for i := range w.fs.b {
			if w.fs.b[i].present {
				names = append(names, cachefs.BucketName(i))
			}
		}
		for n := range w.fs.strays {
			names = append(names, n)
		}
		slices.Sort(names)
		return names, nil
	}
	bk, f, _, err := w.resolve(rel)
	if err != nil {
		return nil, err
	}
	if f != nil {
		if !f.dir || f.special != 0 {
			return nil, &fs.PathError{Op: "open", Path: rel, Err: syscall.ENOTDIR}
		}
		if f.inner == nil {
			return nil, nil
		}
		return []string{f.innerName}, nil
	}
	names := make([]string, 0, len(bk.files))
	for n := range bk.files {
		names = append(names, n)
	}
	slices.Sort(names)
	return names, nil
}

func (w *World) ReadPrefix(rel string, buf []byte) (int, error) {
	w.op()
	b, f, in, err := w.resolve(rel)
	_ = b
	if err != nil {
		return 0, err
	}
	if in != nil || f.dir || f.special != 0 {
		return 0, &fs.PathError{Op: "read", Path: rel, Err: syscall.EINVAL}
	}
	data := f.content
	if data == nil {
		bi, name, _, _ := split(rel)
		_ = bi
		data = fmt.Appendf(nil, "v1 %s %x %20d %20d\n", name[:64], f.out, 0, f.written)
	}
	if f.atime < f.mtime {
		f.atime = w.WallNs() // the daemon's read bumps atime but is not a use
	}
	return copy(buf, data), nil
}

func isAction(rel string) bool { return strings.HasSuffix(rel, "-a") }

func (w *World) RemoveIfIdle(rel string, ino uint64, cutoff int64) (cachefs.Outcome, cachefs.Stat, error) {
	w.op()
	if !cachefs.Allowed(rel) {
		w.violate("remove outside managed names: %s", rel)
		return cachefs.Refused, cachefs.Stat{}, cachefs.ErrForbidden
	}
	bk, f, in, err := w.resolve(rel)
	if err != nil {
		return cachefs.Gone, cachefs.Stat{}, nil
	}
	target := f
	if in != nil {
		target = in
	}
	st := statOf(target)
	rec := st.Recency()
	if isAction(rel) {
		rec = st.Mtime
	}
	switch {
	case st.Type != cachefs.Regular:
		return cachefs.Refused, st, nil
	case st.Ino != ino:
		return cachefs.Replaced, st, nil
	case rec >= cutoff:
		return cachefs.Fresh, st, nil
	case target.refused:
		w.RefusedTries++
		return cachefs.Refused, st, &fs.PathError{Op: "unlink", Path: rel, Err: syscall.EPERM}
	}
	w.checkRemoval(rel, f, in)
	w.checkPinned(rel)
	w.d4Removed(rel, target, target.alloc)
	if in != nil {
		f.inner, f.innerName = nil, ""
		f.mtime = w.WallNs()
	} else {
		delete(bk.files, rel[3:])
		bk.mtime = w.WallNs()
	}
	w.release(target.alloc)
	w.Removals = append(w.Removals, Removal{Rel: rel, Mono: w.mono, AwakeAge: w.mono - target.recMono, Bytes: target.alloc, FreeAtCut: w.freeSamples[1], Live: w.liveGo()})
	w.removedAt[rel] = w.mono
	w.Mutations++
	return cachefs.Removed, st, nil
}

func (w *World) RemoveEmptyDir(rel string, cutoff int64) (cachefs.Outcome, error) {
	w.op()
	if !cachefs.Allowed(rel) {
		w.violate("rmdir outside managed names: %s", rel)
		return cachefs.Refused, cachefs.ErrForbidden
	}
	bk, f, _, err := w.resolve(rel)
	if err != nil || f == nil {
		return cachefs.Gone, nil
	}
	if !f.dir || f.special != 0 {
		return cachefs.Refused, nil
	}
	if f.mtime >= cutoff {
		return cachefs.Fresh, nil
	}
	if f.inner != nil {
		return cachefs.Refused, &fs.PathError{Op: "rmdir", Path: rel, Err: syscall.ENOTEMPTY}
	}
	w.checkMode("rmdir " + rel)
	w.checkRefs(rel)
	w.d4Removed(rel, f, f.alloc)
	delete(bk.files, rel[3:])
	bk.mtime = w.WallNs()
	w.release(f.alloc)
	w.removedAt[rel] = w.mono
	w.Mutations++
	return cachefs.Removed, nil
}

func (w *World) SetTimes(rel string, ns int64) error {
	w.op()
	w.checkMode("settimes " + rel)
	_, f, in, err := w.resolve(rel)
	if err != nil {
		return err
	}
	if in != nil {
		f = in
	}
	f.mtime, f.atime, f.recMono = ns, ns, w.mono
	w.changed(f)
	w.Mutations++
	return nil
}

func (w *World) Arm(rel string, atime int64) error {
	w.op()
	w.checkMode("arm " + rel)
	_, f, in, err := w.resolve(rel)
	if err != nil {
		return err
	}
	if in != nil {
		f = in
	}
	if f.atime > f.mtime && atime < f.atime {
		w.violate("arm of %s erased read evidence", rel)
	}
	f.atime = atime
	w.changed(f)
	w.Mutations++
	return nil
}

func (w *World) WriteTrim(data []byte) error {
	w.op()
	w.checkMode("write trim.txt")
	v, err := strconv.ParseInt(string(data), 10, 64)
	if err != nil || v > w.WallNs()/int64(time.Second)+1 || v < w.WallNs()/int64(time.Second)-3600 {
		w.violate("trim.txt %q is not now in unix seconds", data)
	}
	w.fs.trim = v
	w.TrimWrites = append(w.TrimWrites, w.mono)
	w.Mutations++
	return nil
}

func (w *World) release(n int64) {
	if w.disk.FreeIgnoresRemovals {
		w.disk.pinned += n
	}
	w.disk.used -= n
}

// Free implements the daemon's disk source.
func (w *World) Free() (int64, error) {
	w.op()
	f := w.FreeNow()
	w.freeSamples[0], w.freeSamples[1] = w.freeSamples[1], f
	w.d4Sample(f)
	return f, nil
}

// FreeNow is the ground-truth free disk.
func (w *World) FreeNow() int64 {
	return w.disk.capacity - w.disk.used - w.disk.external - w.disk.pinned
}

// SetExternal sets the bytes used outside the cache.
func (w *World) SetExternal(n int64) { w.disk.external = n }

// SetCapacity sets the disk size.
func (w *World) SetCapacity(n int64) { w.disk.capacity = n }

// FreeIgnoresRemovals makes removals give back no disk (an APFS snapshot).
func (w *World) FreeIgnoresRemovals(on bool) { w.disk.FreeIgnoresRemovals = on }

// CacheBytes is the ground-truth allocated size of managed entries.
func (w *World) CacheBytes() int64 {
	var n int64
	for i := range w.fs.b {
		for name, f := range w.fs.b[i].files {
			if _, _, ok := cachefs.ParseEntryName(i, name); ok && f.special == 0 {
				n += f.totalAlloc()
			}
		}
	}
	return n
}

// AddTemp leaves a client temp file of pid in bucket b, written age ago.
func (w *World) AddTemp(b int, pid int32, size int64, age time.Duration) string {
	bk := &w.fs.b[b]
	w.touchBucket(bk)
	w.fs.nextIno++
	name := fmt.Sprintf("%s%d.%d", store.TempPrefix, pid, w.fs.nextIno)
	t := w.WallNs() - int64(age)
	bk.files[name] = &file{size: size, alloc: alloc4k(size), mtime: t, atime: t, useMono: w.mono - age, recMono: w.mono - age, ino: w.fs.newIno()}
	w.addUsed(alloc4k(size))
	w.tempUsed += alloc4k(size)
	return cachefs.BucketName(b) + "/" + name
}

// Exists reports whether rel exists now.
func (w *World) Exists(rel string) bool {
	_, f, in, err := w.resolve(rel)
	return err == nil && (in != nil || f != nil)
}

func (w *World) RemoveTemp(rel string, ino uint64, cutoff int64) (cachefs.Outcome, cachefs.Stat, error) {
	w.op()
	if !cachefs.TempAllowed(rel) {
		w.violate("temp sweep outside temp names: %s", rel)
		return cachefs.Refused, cachefs.Stat{}, cachefs.ErrForbidden
	}
	bk, f, _, err := w.resolve(rel)
	if err != nil || f == nil {
		return cachefs.Gone, cachefs.Stat{}, nil
	}
	st := statOf(f)
	switch {
	case st.Ino != ino:
		return cachefs.Replaced, st, nil
	case st.Mtime >= cutoff:
		return cachefs.Fresh, st, nil
	}
	w.checkMode("sweep " + rel)
	pid, _, _ := store.ParseTempName(rel[3:])
	age := w.mono - f.recMono
	_, alive := w.procs[int32(pid)]
	if age <= 10*time.Minute || (alive && age <= 2*time.Hour) {
		w.violate("swept %s age %s, writer alive %v", rel, age, alive)
	}
	w.d4Removed(rel, nil, f.alloc)
	delete(bk.files, rel[3:])
	bk.mtime = w.WallNs()
	w.release(f.alloc)
	w.tempUsed -= f.alloc
	w.Mutations++
	w.removedAt[rel] = w.mono
	return cachefs.Removed, st, nil
}

func (w *World) liveGo() int {
	n := 0
	for _, p := range w.procs {
		if p.Comm == "go" {
			n++
		}
	}
	return n
}

// Refuse makes every removal of rel fail with EPERM (chmod 555 bucket, uchg).
func (w *World) Refuse(rel string) {
	_, f, in, err := w.resolve(rel)
	if err != nil {
		panic(err)
	}
	if in != nil {
		f = in
	}
	f.refused = true
}

// GoClean is `go clean -cache`: every bucket directory goes.
func (w *World) GoClean() {
	for i := range w.fs.b {
		b := &w.fs.b[i]
		if !b.present {
			continue
		}
		for _, f := range b.files {
			w.disk.used -= f.totalAlloc()
		}
		*b = bucket{}
	}
	w.tempUsed = 0
	w.Note("go clean -cache")
}

// Times returns rel's mtime and atime (wall ns).
func (w *World) Times(rel string) (mtime, atime int64, ok bool) {
	_, f, in, err := w.resolve(rel)
	if err != nil {
		return 0, 0, false
	}
	if in != nil {
		f = in
	}
	return f.mtime, f.atime, true
}

// TrimValue is the last trim.txt value written (unix seconds), 0 if none.
func (w *World) TrimValue() int64 { return w.fs.trim }
