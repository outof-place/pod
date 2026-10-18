// Package cachefs is the daemon's only door into a GOCACHE directory. It can
// list and stat anything, but it removes only <xx>/<64 hex>-a and -d entries
// (and the one file inside an executable -d directory), rewrites only
// trim.txt, and never follows a symlink.
package cachefs

import (
	"errors"
	"strings"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

// Type is the kind of a directory entry, from lstat(2).
type Type uint8

const (
	Other Type = iota
	Regular
	Dir
	Symlink
)

// Stat is what the daemon uses from lstat(2). Times are unix nanoseconds.
type Stat struct {
	Type  Type
	Size  int64
	Alloc int64 // st_blocks * 512: what removing the file gives back
	Mtime int64
	Atime int64
	Ctime int64 // any write, rename or attribute change moves it
	Ino   uint64
}

// Recency is the newest of mtime and atime: Go refreshes mtime on use, and a
// read bumps atime when atime is older than mtime (APFS), so either is use.
func (s Stat) Recency() int64 { return max(s.Mtime, s.Atime) }

// RecencyOf is the recency removal checks use: mtime only for an -a (the
// daemon reads -a files itself, which may bump atime), Recency otherwise.
func RecencyOf(rel string, s Stat) int64 {
	if strings.HasSuffix(rel, "-a") {
		return s.Mtime
	}
	return s.Recency()
}

// Outcome says what a guarded removal did.
type Outcome uint8

const (
	Removed  Outcome = iota
	Fresh            // in use since the plan: newer than the cutoff
	Replaced         // a different file now has the name
	Gone             // already missing
	Refused          // not a regular file, or not removable (EACCES, EPERM)
)

// FS is a GOCACHE directory. Paths are relative to its root and use "/".
type FS interface {
	// Lstat stats rel without following symlinks; rel "" is the root.
	Lstat(rel string) (Stat, error)
	// ReadDirNames lists rel ("" is the root), sorted.
	ReadDirNames(rel string) ([]string, error)
	// ReadPrefix reads up to len(buf) bytes of the regular file rel without
	// following symlinks or blocking on a FIFO.
	ReadPrefix(rel string, buf []byte) (int, error)
	// RemoveIfIdle unlinks the entry file rel only if it is still the regular
	// file with inode ino and its recency is older than cutoff. The check and
	// the unlink are one step; the result carries the stat that decided.
	RemoveIfIdle(rel string, ino uint64, cutoff int64) (Outcome, Stat, error)
	// RemoveEmptyDir removes an executable -d directory that has no entries.
	RemoveEmptyDir(rel string, cutoff int64) (Outcome, error)
	// SetTimes sets an entry's mtime and atime (future timestamps only).
	SetTimes(rel string, ns int64) error
	// Arm sets only the atime of an entry file queued for removal, below its
	// mtime, so any read before the removal bumps atime (APFS updates atime
	// on read only when it is older than mtime) and keeps the file.
	Arm(rel string, atime int64) error
	// RemoveTemp unlinks a pod-gocache client temp file (store.TempPrefix names)
	// only if it is still the regular file ino with mtime older than cutoff.
	RemoveTemp(rel string, ino uint64, cutoff int64) (Outcome, Stat, error)
	// WriteTrim rewrites trim.txt under Go's flock protocol.
	WriteTrim(data []byte) error
}

// TempAllowed reports whether rel is a client temp file directly in a bucket.
func TempAllowed(rel string) bool {
	bucket, name, ok := strings.Cut(rel, "/")
	if !ok || strings.Contains(name, "/") {
		return false
	}
	if _, ok := ParseBucketName(bucket); !ok {
		return false
	}
	_, _, ok = store.ParseTempName(name)
	return ok
}

// ErrForbidden is returned for any mutation outside the allowed names.
var ErrForbidden = errors.New("cachefs: path outside the managed entries")

// ErrTrimBusy is returned when another process keeps trim.txt locked.
var ErrTrimBusy = errors.New("cachefs: trim.txt is locked by another process")

var errNoStat = errors.New("cachefs: no stat_t from lstat")

// Kind of a managed entry name.
const (
	KindAction byte = 'a'
	KindOutput byte = 'd'
)

// ParseBucketName is BucketName's inverse: "00".."ff" (lowercase) only.
func ParseBucketName(name string) (int, bool) {
	if len(name) != 2 {
		return 0, false
	}
	hi, ok1 := hexVal(name[0])
	lo, ok2 := hexVal(name[1])
	return int(hi<<4 | lo), ok1 && ok2
}

// BucketName is "00".."ff".
func BucketName(b int) string {
	const hexdigits = "0123456789abcdef"
	return string([]byte{hexdigits[b>>4], hexdigits[b&15]})
}

// ParseEntryName accepts exactly <64 lowercase hex>-a or -d whose first two
// hex digits name bucket b. Anything else is not an entry.
func ParseEntryName(b int, name string) (id [32]byte, kind byte, ok bool) {
	if len(name) != 66 || name[64] != '-' || (name[65] != KindAction && name[65] != KindOutput) {
		return id, 0, false
	}
	for i := 0; i < 32; i++ {
		hi, ok1 := hexVal(name[2*i])
		lo, ok2 := hexVal(name[2*i+1])
		if !ok1 || !ok2 {
			return id, 0, false
		}
		id[i] = hi<<4 | lo
	}
	if int(id[0]) != b {
		return id, 0, false
	}
	return id, name[65], true
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	}
	return 0, false
}

// EntryRel is <xx>/<hex>-<kind>.
func EntryRel(id [32]byte, kind byte) string {
	const hexdigits = "0123456789abcdef"
	var b [2 + 1 + 64 + 2]byte
	b[0], b[1], b[2] = hexdigits[id[0]>>4], hexdigits[id[0]&15], '/'
	for i, v := range id {
		b[3+2*i] = hexdigits[v>>4]
		b[3+2*i+1] = hexdigits[v&15]
	}
	b[67], b[68] = '-', kind
	return string(b[:])
}

// Allowed reports whether rel may be removed or retimed: an entry, or the one
// file directly inside an -d directory.
func Allowed(rel string) bool {
	bucket, rest, ok := strings.Cut(rel, "/")
	if !ok {
		return false
	}
	b, ok := ParseBucketName(bucket)
	if !ok {
		return false
	}
	name, inner, hasInner := strings.Cut(rest, "/")
	_, kind, ok := ParseEntryName(b, name)
	if !ok {
		return false
	}
	if !hasInner {
		return true
	}
	return kind == KindOutput && inner != "" && inner != "." && inner != ".." && !strings.Contains(inner, "/")
}
