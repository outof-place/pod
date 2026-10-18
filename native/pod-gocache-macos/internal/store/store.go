// Package store reads and writes Go's native GOCACHE layout, byte compatible
// with cmd/go/internal/cache in both directions. It touches only bucket
// directories, their <hex>-a and <hex>-d entries and its own temp files.
package store

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// maxPath is PATH_MAX on darwin; paths are built in fixed arrays of this size.
const maxPath = 1024

// mtimeInterval mirrors cache.go: mtimes are refreshed at most hourly.
const mtimeInterval = time.Hour

// Store is one client's view of a GOCACHE directory. Without shared state
// Get is safe for concurrent use; with it (SetLive), the session counters
// need one caller at a time, as runProg's single serving loop is. Put is
// called by one goroutine at a time.
type Store struct {
	dir  string // absolute GOCACHE, or "" when there is no usable store
	pid  int
	seq  atomic.Uint64
	buf  []byte            // put streaming buffer, owned by the Put caller
	live *livestate.Client // the daemon's shared state; nil: S1 standalone
}

// Open returns a store on dir. A dir that is empty, not absolute, too long or
// not valid UTF-8 (DiskPath travels as a JSON string) yields a store with no
// directory: every get misses and every put fails.
func Open(dir string) *Store {
	s := &Store{pid: os.Getpid()}
	if dir != "" && filepath.IsAbs(dir) && utf8.ValidString(dir) && len(dir)+1+2+1+hexSize+2 < maxPath-32 {
		s.dir = filepath.Clean(dir)
	}
	return s
}

// Dir is the store directory, "" when there is none.
func (s *Store) Dir() string { return s.dir }

// SetLive makes gets and puts use the daemon's shared state. Call before the
// first request.
func (s *Store) SetLive(c *livestate.Client) { s.live = c }

// pathBuf holds one path built without allocating.
type pathBuf struct {
	b [maxPath]byte
	n int
}

func (p *pathBuf) bytes() []byte { return p.b[:p.n] }

// str views the buffer as a string; valid only while p is unchanged.
func (p *pathBuf) str() string { return unsafe.String(&p.b[0], p.n) }

// entryPath builds <dir>/<xx>/<hex id>-<kind>, cache.go's fileName.
func (s *Store) entryPath(p *pathBuf, id *[hashSize]byte, kind byte) string {
	n := copy(p.b[:], s.dir)
	p.b[n] = '/'
	n++
	hex.Encode(p.b[n:n+2], id[:1])
	n += 2
	p.b[n] = '/'
	n++
	hex.Encode(p.b[n:n+hexSize], id[:])
	n += hexSize
	p.b[n] = '-'
	p.b[n+1] = kind
	p.n = n + 2
	return p.str()
}

// bucketPath builds <dir>/<xx>.
func (s *Store) bucketPath(p *pathBuf, id *[hashSize]byte) string {
	n := copy(p.b[:], s.dir)
	p.b[n] = '/'
	n++
	hex.Encode(p.b[n:n+2], id[:1])
	p.n = n + 2
	return p.str()
}

// Hit is a get hit. DiskPath points into the Hit, so reuse one Hit per goroutine.
type Hit struct {
	OutputID [hashSize]byte
	Size     int64
	Time     int64 // unix nanoseconds, from the index entry
	Fast     bool  // the entry came from the daemon's shared index
	path     pathBuf
}

// DiskPath is the output file; valid until the Hit is reused.
func (h *Hit) DiskPath() []byte { return h.path.bytes() }

// Get looks up id like (*DiskCache).get followed by OutputFile and the size
// check every cmd/go caller makes (GetFile, GetBytes, GetMmap). It never
// fails: anything unexpected is a miss.
func (s *Store) Get(id *[hashSize]byte, h *Hit) bool {
	ok := s.get(id, h)
	if s.live != nil {
		if !ok {
			s.live.Misses++
		}
		s.live.Note()
	}
	return ok
}

func (s *Store) get(id *[hashSize]byte, h *Hit) bool {
	if s.dir == "" {
		return false
	}
	var ap pathBuf
	apath := s.entryPath(&ap, id, 'a')
	var e entry
	var amtime syscall.Timespec
	kind, src := s.fromIndex(id, apath, &e, &amtime)
	switch src {
	case srcGone:
		return false
	case srcDisk, srcStale:
		// A stale entry already has the -a file's stat (for markUsed, as the
		// built-in cache stats by path), so the read skips its fstat.
		ok, mtimeOK := readEntry(apath, id, &e, &amtime, src == srcStale)
		if !ok {
			return false
		}
		if !mtimeOK {
			amtime = syscall.NsecToTimespec(time.Now().UnixNano()) // fstat failed: S1 skips markUsed
		}
	}
	now := time.Now()
	if markUsed(apath, amtime, now) {
		kind |= livestate.RecordRefreshed
	}
	// Pin before the -d is looked at: the daemon either sees the pin before it
	// deletes the output, or the output shows up here as dying.
	if testHook != nil {
		testHook(hookBeforePin)
	}
	if s.live != nil && s.live.Pin(&e.out, id, kind, e.size) {
		s.live.DyingMisses++
		return false
	}
	if testHook != nil {
		testHook(hookAfterPin)
	}
	dpath := s.entryPath(&h.path, &e.out, 'd')
	var dst syscall.Stat_t
	if statRetry(dpath, &dst) != nil {
		return false
	}
	markUsed(dpath, dst.Mtimespec, now)
	switch dst.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		if dst.Size != e.size {
			return false
		}
	case syscall.S_IFDIR:
		if !executablePath(&h.path, e.size) {
			return false
		}
	default:
		return false
	}
	h.OutputID, h.Size, h.Time, h.Fast = e.out, e.size, e.time, src == srcIndex
	if s.live != nil {
		if h.Fast {
			s.live.Fast++
		} else {
			s.live.Disk++
		}
	}
	return true
}

// testHook lets a test act as the daemon at points inside Get.
var testHook func(point int)

const (
	hookBeforePin = 1
	hookAfterPin  = 2
)

// Where an entry came from.
const (
	srcDisk  = iota // read the -a file
	srcIndex        // the shared index, confirmed by a stat of the -a file
	srcGone         // the index had it and the -a file is gone: a miss
	srcStale        // read the -a file, whose stat (in amtime) did not match the index
)

// fromIndex serves id from the shared index when a stat shows the -a file is
// still the inode, ctime and size the daemon read: then its content is what
// the daemon parsed, and reading the file would return the same entry.
// Anything else sends the get to the -a file.
func (s *Store) fromIndex(id *[hashSize]byte, apath string, e *entry, amtime *syscall.Timespec) (kind uint64, src int) {
	if s.live == nil {
		return livestate.KindHitDisk, srcDisk
	}
	var le livestate.Entry
	if !s.live.Lookup(id, &le) {
		// Not published (yet): the daemon finds new -a files on its own.
		return livestate.KindHitDisk, srcDisk
	}
	var st syscall.Stat_t
	if err := statRetry(apath, &st); err != nil {
		if err == syscall.ENOENT {
			return 0, srcGone
		}
		return livestate.KindHitDisk, srcDisk
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Ino != le.Ino || st.Ctimespec.Nano() != le.Ctime || st.Size != entrySize {
		s.live.Stale++
		*amtime = st.Mtimespec
		return livestate.KindHitDisk | livestate.RecordStale, srcStale
	}
	e.out, e.size, e.time = le.Output, le.Size, le.Time
	*amtime = st.Mtimespec
	return livestate.KindHitFast, srcIndex
}

// readEntry reads id's -a file like (*DiskCache).get. With known, mtime
// already holds the file's mtime; otherwise it comes from an fstat, and
// mtimeOK is false when that failed (then markUsed is skipped).
func readEntry(apath string, id *[hashSize]byte, e *entry, mtime *syscall.Timespec, known bool) (ok, mtimeOK bool) {
	fd, err := openRetry(apath, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false, false
	}
	var ast syscall.Stat_t
	var statErr error
	if !known {
		statErr = fstatRetry(fd, &ast)
	}
	var buf [entrySize + 1]byte
	n := readFull(fd, buf[:])
	syscall.Close(fd)
	if *e, ok = parseEntry(buf[:n], id); !ok {
		return false, false
	}
	if !known {
		*mtime = ast.Mtimespec
	}
	return true, statErr == nil
}

// executablePath resolves an executable entry (a -d directory holding one
// file, written by the built-in cache for go run and go tool) to that file.
func executablePath(p *pathBuf, size int64) bool {
	dir := string(p.bytes())
	ents, err := os.ReadDir(dir)
	if err != nil || len(ents) != 1 {
		return false
	}
	inner := filepath.Join(dir, ents[0].Name())
	if len(inner) >= maxPath {
		return false
	}
	fi, err := os.Stat(inner)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != size {
		return false
	}
	p.n = copy(p.b[:], inner)
	return true
}

// markUsed mirrors (*DiskCache).markUsed: refresh mtime when it is an hour old,
// so built-in trims in other go processes see the entry as used. It reports
// whether it refreshed.
func markUsed(path string, mtime syscall.Timespec, now time.Time) bool {
	if now.Sub(time.Unix(mtime.Unix())) < mtimeInterval {
		return false
	}
	ts := syscall.NsecToTimespec(now.UnixNano())
	syscall.UtimesNano(path, []syscall.Timespec{ts, ts})
	return true
}

func openRetry(path string, mode int, perm uint32) (int, error) {
	for {
		fd, err := syscall.Open(path, mode, perm)
		if err != syscall.EINTR {
			return fd, err
		}
	}
}

func statRetry(path string, st *syscall.Stat_t) error {
	for {
		err := syscall.Stat(path, st)
		if err != syscall.EINTR {
			return err
		}
	}
}

func fstatRetry(fd int, st *syscall.Stat_t) error {
	for {
		err := syscall.Fstat(fd, st)
		if err != syscall.EINTR {
			return err
		}
	}
}

// readFull reads until buf is full, EOF or an error, like io.ReadFull.
func readFull(fd int, buf []byte) int {
	n := 0
	for n < len(buf) {
		m, err := syscall.Read(fd, buf[n:])
		if err == syscall.EINTR {
			continue
		}
		if err != nil || m <= 0 {
			break
		}
		n += m
	}
	return n
}
