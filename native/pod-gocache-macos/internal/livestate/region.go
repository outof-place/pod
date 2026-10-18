package livestate

import (
	"errors"
	"os"
	"runtime/debug"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// region is a mapped part of a shared file. Every access is an atomic 64-bit
// load or store at an 8-byte-aligned offset, so a reader never sees half of a
// word and the race detector, which ignores memory outside the Go heap, has
// nothing to report.
type region struct{ b []byte }

func (r region) word(off int) *uint64 {
	// Mappings are page-aligned and every offset in layout.go is a multiple
	// of 8, so the word is aligned; indexing bounds-checks off.
	return (*uint64)(unsafe.Pointer(&r.b[off]))
}

func (r region) load(off int) uint64     { return atomic.LoadUint64(r.word(off)) }
func (r region) store(off int, v uint64) { atomic.StoreUint64(r.word(off), v) }

// loadID reads four words at off into id.
func (r region) loadID(off int, id *[32]byte) {
	for i := range 4 {
		v := r.load(off + 8*i)
		for j := range 8 {
			id[8*i+j] = byte(v >> (8 * j))
		}
	}
}

// storeID writes id as four words at off.
func (r region) storeID(off int, id *[32]byte) {
	for i := range 4 {
		r.store(off+8*i, idWord(id, i))
	}
}

// idWord is word i of id, little-endian.
func idWord(id *[32]byte, i int) uint64 {
	var v uint64
	for j := range 8 {
		v |= uint64(id[8*i+j]) << (8 * j)
	}
	return v
}

// Prefix is the first word of an ID: what slot logs and the dying table carry.
func Prefix(id *[32]byte) uint64 { return idWord(id, 0) }

// protect runs f and reports false if it faulted or panicked. A mapped file
// can be truncated under us by another process; SetPanicOnFault turns the
// resulting SIGBUS into a panic recovered here instead of a crash, which for
// a GOCACHEPROG client would fail the go command ("exited pre-Close").
func protect(f func()) (ok bool) {
	old := debug.SetPanicOnFault(true)
	defer func() {
		debug.SetPanicOnFault(old)
		if recover() != nil {
			ok = false
		}
	}()
	f()
	return true
}

var (
	errNotRegular = errors.New("livestate: not a regular file")
	errForeign    = errors.New("livestate: owned by another user or open to others")
	errSize       = errors.New("livestate: unexpected size")
)

// openChecked opens a shared file without following a symlink or blocking on
// a FIFO, and accepts only a regular file of this user, closed to everyone
// else, with a size in [minSize, maxSize].
func openChecked(path string, write bool, minSize, maxSize int64) (fd int, size int64, err error) {
	mode := syscall.O_RDONLY
	if write {
		mode = syscall.O_RDWR
	}
	for {
		fd, err = syscall.Open(path, mode|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		return -1, 0, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return -1, 0, err
	}
	switch {
	case st.Mode&syscall.S_IFMT != syscall.S_IFREG:
		err = errNotRegular
	case st.Uid != uint32(os.Getuid()) || st.Mode&0o077 != 0:
		err = errForeign
	case st.Size < minSize || st.Size > maxSize:
		err = errSize
	}
	if err != nil {
		syscall.Close(fd)
		return -1, 0, err
	}
	return fd, st.Size, nil
}

func mapShared(fd int, off int64, length int, write bool) ([]byte, error) {
	prot := syscall.PROT_READ
	if write {
		prot |= syscall.PROT_WRITE
	}
	return syscall.Mmap(fd, off, length, prot, syscall.MAP_SHARED)
}
