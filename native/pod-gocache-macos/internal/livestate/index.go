package livestate

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// Entry is one published -a entry: what the -a file said (output, size,
// time) and the -a file's inode and ctime when the daemon read it.
type Entry struct {
	Output [32]byte
	Size   int64
	Time   int64 // unix ns, from the -a line
	Ino    uint64
	Ctime  int64 // ns
	Mtime  int64 // ns, informational
}

// Result of an index lookup. Only Found is used; the other two send the
// client to the -a file, since the index may simply not know an entry yet.
type Result uint8

const (
	Absent Result = iota // the probe chain ended without the ID
	Found
	Unsure // a slot stayed mid-write, or the chain ran past maxProbe
)

// mix64 is splitmix64's finalizer.
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// hashID hashes all 32 bytes with the index's random seed, so IDs that share
// a prefix don't share a probe chain unless the seed says so.
func hashID(id *[32]byte, seed uint64) uint64 {
	h := seed
	for i := range 4 {
		h = mix64(h ^ idWord(id, i))
	}
	return h
}

var errBadIndex = errors.New("livestate: index header does not match")

// Index is a read-only view of a published index.
type Index struct {
	r    region
	mask uint64
	seed uint64
}

// OpenIndex maps dir/index if it is a valid index for cache id. The length
// mapped is fstat's, and every header field must agree with it, so nothing
// is ever read beyond the file.
func OpenIndex(dir string, id CacheID) (*Index, error) {
	fd, size, err := openChecked(filepath.Join(dir, IndexName), false, idxHeaderSize+idxMinSlots*idxSlotSize, idxHeaderSize+idxMaxSlots*idxSlotSize)
	if err != nil {
		return nil, err
	}
	b, err := mapShared(fd, 0, int(size), false)
	syscall.Close(fd)
	if err != nil {
		return nil, err
	}
	x := &Index{r: region{b}}
	valid := false
	ok := protect(func() {
		h := x.r
		slots := h.load(ihSlots)
		valid = string(b[ihMagic:ihMagic+8]) == idxMagic && h.load(ihVersion) == Version &&
			h.load(ihHeaderSize) == idxHeaderSize && h.load(ihFileSize) == uint64(size) &&
			h.load(ihSlotSize) == idxSlotSize && slots >= idxMinSlots && slots <= idxMaxSlots &&
			slots&(slots-1) == 0 && idxHeaderSize+slots*idxSlotSize == uint64(size) &&
			h.load(ihCacheDev) == id.Dev && h.load(ihCacheIno) == id.Ino
		x.mask, x.seed = slots-1, h.load(ihSeed)
	})
	if !ok || !valid {
		syscall.Munmap(b)
		return nil, errBadIndex
	}
	return x, nil
}

// Close unmaps the index.
func (x *Index) Close() { syscall.Munmap(x.r.b) }

// Superseded reports whether the daemon has published a newer index file.
// Call inside protect.
func (x *Index) Superseded() bool { return x.r.load(ihSuperseded) != 0 }

// Lookup finds id. Call inside protect: the mapping may fault.
func (x *Index) Lookup(id *[32]byte, e *Entry) Result {
	h := hashID(id, x.seed)
	w0, w1, w2, w3 := idWord(id, 0), idWord(id, 1), idWord(id, 2), idWord(id, 3)
	for p := uint64(0); p < maxProbe; p++ {
		off := idxHeaderSize + int((h+p)&x.mask)*idxSlotSize
		settled := false
		for range readTries {
			s1 := x.r.load(off + 8*isSeq)
			if s1 == 0 {
				return Absent // never written: the end of every chain through here
			}
			if s1&1 != 0 {
				continue // the daemon is rewriting it
			}
			match := x.r.load(off+8*isState) == slotLive &&
				x.r.load(off+8*isAction) == w0 && x.r.load(off+8*(isAction+1)) == w1 &&
				x.r.load(off+8*(isAction+2)) == w2 && x.r.load(off+8*(isAction+3)) == w3
			if match {
				x.r.loadID(off+8*isOutput, &e.Output)
				e.Size = int64(x.r.load(off + 8*isSize))
				e.Time = int64(x.r.load(off + 8*isTime))
				e.Ino = x.r.load(off + 8*isIno)
				e.Ctime = int64(x.r.load(off + 8*isCtime))
				e.Mtime = int64(x.r.load(off + 8*isMtime))
			}
			if x.r.load(off+8*isSeq) != s1 {
				continue // torn: read it again
			}
			if match {
				return Found
			}
			settled = true
			break
		}
		if !settled {
			return Unsure
		}
	}
	return Unsure
}

// IndexWriter is the daemon's side of one index file. Not safe for
// concurrent use; it is the only writer of the file.
type IndexWriter struct {
	dir   string
	b     []byte
	r     region
	mask  uint64
	seed  uint64
	where map[[32]byte]uint32 // live IDs -> slot
	used  int                 // slots ever written: live and deleted
	Full  int                 // inserts refused: no free slot within maxProbe
}

// CreateIndex writes a new, empty index for cache id with slots slots (a
// power of two) and renames it over dir/index; a previous index is marked
// superseded so its readers move to the new one. The file is written with
// zeros first, so a full disk fails here and never later in a mapped write.
func CreateIndex(dir string, id CacheID, slots int, generation uint64, boot [16]byte) (*IndexWriter, error) {
	var seed [8]byte
	rand.Read(seed[:])
	return createIndex(dir, id, slots, generation, boot, binary.LittleEndian.Uint64(seed[:]))
}

func createIndex(dir string, id CacheID, slots int, generation uint64, boot [16]byte, seed uint64) (*IndexWriter, error) {
	if slots < idxMinSlots || slots > idxMaxSlots || slots&(slots-1) != 0 {
		return nil, errors.New("livestate: index slots must be a power of two in range")
	}
	size := idxHeaderSize + slots*idxSlotSize
	tmp := filepath.Join(dir, ".index."+strconv.Itoa(os.Getpid())+"."+strconv.FormatUint(generation, 10))
	syscall.Unlink(tmp)
	b, err := createZeroed(tmp, size)
	if err != nil {
		return nil, err
	}
	w := &IndexWriter{dir: dir, b: b, r: region{b}, mask: uint64(slots - 1), seed: seed, where: map[[32]byte]uint32{}}
	ok := protect(func() {
		copy(b[ihMagic:], idxMagic)
		h := w.r
		h.store(ihVersion, Version)
		h.store(ihHeaderSize, idxHeaderSize)
		h.store(ihFileSize, uint64(size))
		h.store(ihSlots, uint64(slots))
		h.store(ihSlotSize, idxSlotSize)
		h.store(ihCacheDev, id.Dev)
		h.store(ihCacheIno, id.Ino)
		h.store(ihSeed, w.seed)
		h.store(ihGeneration, generation)
		h.store(ihDaemonPID, uint64(os.Getpid()))
		h.store(ihCreated, uint64(AwakeNow()))
		copy(b[ihBootID:ihBootID+16], boot[:])
	})
	if !ok {
		w.Close()
		syscall.Unlink(tmp)
		return nil, errors.New("livestate: index header write faulted")
	}
	final := filepath.Join(dir, IndexName)
	old, _ := supersedable(final)
	if err := syscall.Rename(tmp, final); err != nil {
		w.Close()
		syscall.Unlink(tmp)
		if old != nil {
			syscall.Munmap(old)
		}
		return nil, err
	}
	if old != nil {
		protect(func() { region{old}.store(ihSuperseded, 1) })
		syscall.Munmap(old)
	}
	return w, nil
}

// supersedable maps an existing index read-write so its superseded flag can
// be set after the rename.
func supersedable(path string) ([]byte, error) {
	fd, size, err := openChecked(path, true, idxHeaderSize, idxHeaderSize+idxMaxSlots*idxSlotSize)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	return mapShared(fd, 0, int(size), true)
}

// createZeroed creates path (0600, failing if it exists), fills size bytes
// of zeros and maps it read-write.
func createZeroed(path string, size int) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	if err := zeroFill(fd, 0, size); err != nil {
		syscall.Unlink(path)
		return nil, err
	}
	b, err := mapShared(fd, 0, size, true)
	if err != nil {
		syscall.Unlink(path)
	}
	return b, err
}

func zeroFill(fd, off, n int) error {
	zeros := make([]byte, 1<<20)
	for n > 0 {
		k := min(n, len(zeros))
		m, err := syscall.Pwrite(fd, zeros[:k], int64(off))
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		off, n = off+m, n-m
	}
	return nil
}

// Close unmaps the file. The file stays published.
func (w *IndexWriter) Close() {
	if w.b != nil {
		syscall.Munmap(w.b)
		w.b = nil
	}
}

// Slots is the table size.
func (w *IndexWriter) Slots() int { return int(w.mask + 1) }

// Live is the number of published entries.
func (w *IndexWriter) Live() int { return len(w.where) }

// Crowded reports whether the table should be rebuilt: too full, or too many
// deleted slots lengthening the chains.
func (w *IndexWriter) Crowded() bool {
	n := w.Slots()
	return len(w.where) > n*45/100 || w.used > n*65/100
}

// writeSlot rewrites slot i under its sequence number. Call inside protect.
func (w *IndexWriter) writeSlot(i uint32, state uint64, id *[32]byte, e *Entry) {
	off := idxHeaderSize + int(i)*idxSlotSize
	seq := w.r.load(off + 8*isSeq)
	w.r.store(off+8*isSeq, seq|1)
	w.r.store(off+8*isState, state)
	if id != nil {
		w.r.storeID(off+8*isAction, id)
	}
	if e != nil {
		w.r.storeID(off+8*isOutput, &e.Output)
		w.r.store(off+8*isSize, uint64(e.Size))
		w.r.store(off+8*isTime, uint64(e.Time))
		w.r.store(off+8*isIno, e.Ino)
		w.r.store(off+8*isCtime, uint64(e.Ctime))
		w.r.store(off+8*isMtime, uint64(e.Mtime))
	}
	w.r.store(off+8*isSeq, (seq|1)+1)
}

// Put publishes or updates id. It reports false when the table has no slot
// for it within maxProbe (counted in Full; readers then use the -a file).
func (w *IndexWriter) Put(id *[32]byte, e *Entry) bool {
	if i, ok := w.where[*id]; ok {
		return protect(func() { w.writeSlot(i, slotLive, nil, e) })
	}
	h := hashID(id, w.seed)
	placed := false
	ok := protect(func() {
		for p := uint64(0); p < maxProbe; p++ {
			i := uint32((h + p) & w.mask)
			off := idxHeaderSize + int(i)*idxSlotSize
			seq := w.r.load(off + 8*isSeq)
			if seq != 0 && w.r.load(off+8*isState) == slotLive {
				continue
			}
			if seq == 0 {
				w.used++
			}
			w.writeSlot(i, slotLive, id, e)
			w.where[*id] = i
			placed = true
			return
		}
	})
	if !placed {
		w.Full++
	}
	if ok {
		protect(func() { w.r.store(ihLive, uint64(len(w.where))) })
	}
	return ok && placed
}

// Delete unpublishes id.
func (w *IndexWriter) Delete(id *[32]byte) {
	i, ok := w.where[*id]
	if !ok {
		return
	}
	delete(w.where, *id)
	protect(func() {
		w.writeSlot(i, slotDeleted, nil, nil)
		w.r.store(ihLive, uint64(len(w.where)))
	})
}
