package cachefs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

// OS is a GOCACHE directory on disk. Reads use plain lstat/open on full paths
// (bucket directories are checked to be real directories first); every
// mutation goes through os.Root, so it can never leave the cache directory.
type OS struct {
	root    string
	handle  *os.Root
	rootIno uint64
}

// NewOS returns the cache at the absolute, clean path root. It opens nothing
// until the first mutation, so a missing root is fine.
func NewOS(root string) *OS { return &OS{root: root} }

func (c *OS) path(rel string) string {
	if rel == "" {
		return c.root
	}
	return c.root + "/" + rel
}

// StatFromSys converts a raw stat buffer.
func StatFromSys(st *syscall.Stat_t) Stat {
	s := Stat{
		Size:  st.Size,
		Alloc: st.Blocks * 512,
		Mtime: st.Mtimespec.Nano(),
		Atime: st.Atimespec.Nano(),
		Ctime: st.Ctimespec.Nano(),
		Ino:   st.Ino,
	}
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
		s.Type = Regular
	case syscall.S_IFDIR:
		s.Type = Dir
	case syscall.S_IFLNK:
		s.Type = Symlink
	default:
		s.Type = Other
	}
	return s
}

func (c *OS) Lstat(rel string) (Stat, error) {
	var st syscall.Stat_t
	for {
		err := syscall.Lstat(c.path(rel), &st)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return Stat{}, &fs.PathError{Op: "lstat", Path: c.path(rel), Err: err}
		}
		return StatFromSys(&st), nil
	}
}

func (c *OS) ReadDirNames(rel string) ([]string, error) {
	fd, err := openRetry(c.path(rel), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: c.path(rel), Err: err}
	}
	f := os.NewFile(uintptr(fd), c.path(rel))
	defer f.Close()
	names, err := f.Readdirnames(-1)
	slices.Sort(names)
	return names, err
}

func (c *OS) ReadPrefix(rel string, buf []byte) (int, error) {
	fd, err := openRetry(c.path(rel), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC)
	if err != nil {
		return 0, &fs.PathError{Op: "open", Path: c.path(rel), Err: err}
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return 0, &fs.PathError{Op: "read", Path: c.path(rel), Err: syscall.EINVAL}
	}
	n := 0
	for n < len(buf) {
		m, err := syscall.Read(fd, buf[n:])
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return n, err
		}
		if m == 0 {
			break
		}
		n += m
	}
	return n, nil
}

// rootHandle opens (or reopens, after the directory was replaced) the
// os.Root used for every mutation.
func (c *OS) rootHandle() (*os.Root, error) {
	var st syscall.Stat_t
	if err := syscall.Lstat(c.root, &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return nil, fmt.Errorf("cachefs: %s is not a directory", c.root)
	}
	if c.handle != nil && c.rootIno == st.Ino {
		return c.handle, nil
	}
	if c.handle != nil {
		c.handle.Close()
		c.handle = nil
	}
	r, err := os.OpenRoot(c.root)
	if err != nil {
		return nil, err
	}
	c.handle, c.rootIno = r, st.Ino
	return r, nil
}

func (c *OS) RemoveIfIdle(rel string, ino uint64, cutoff int64) (Outcome, Stat, error) {
	if !Allowed(rel) {
		return Refused, Stat{}, ErrForbidden
	}
	r, err := c.rootHandle()
	if err != nil {
		return Gone, Stat{}, err
	}
	fi, err := r.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return Gone, Stat{}, nil
	}
	if err != nil {
		return Refused, Stat{}, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return Refused, Stat{}, errNoStat
	}
	st := StatFromSys(sys)
	switch {
	case st.Type != Regular:
		return Refused, st, nil
	case st.Ino != ino:
		return Replaced, st, nil
	case RecencyOf(rel, st) >= cutoff:
		return Fresh, st, nil
	}
	if beforeRemove != nil {
		beforeRemove(rel)
	}
	if strings.HasSuffix(rel, "-d") {
		// Only an output file can be renamed over by a put after the check.
		return c.removeChecked(r, rel, ino, cutoff, st)
	}
	if err := r.Remove(rel); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Gone, st, nil
		}
		return Refused, st, err
	}
	return Removed, st, nil
}

// beforeRemove runs between RemoveIfIdle's check and its removal (tests).
var beforeRemove func(rel string)

var privateSeq atomic.Uint64

// removeChecked takes whatever rel names now away under a private name in
// its bucket (a client temp name, so a crash leaves something the sweep
// removes), and unlinks it only if it is still the file that was checked. A
// file put there since the check (a put renaming a fresh copy over a dying
// output) goes back under rel, unless yet another copy took the name; copies
// of one output are the same bytes, so either one serves.
func (c *OS) removeChecked(r *os.Root, rel string, ino uint64, cutoff int64, checked Stat) (Outcome, Stat, error) {
	bucket, _, _ := strings.Cut(rel, "/")
	private := bucket + "/" + store.TempPrefix + strconv.Itoa(os.Getpid()) + "." + strconv.FormatUint(privateSeq.Add(1), 10)
	if err := r.Rename(rel, private); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Gone, checked, nil
		}
		return Refused, checked, err
	}
	fi, err := r.Lstat(private)
	var st Stat
	if err == nil {
		if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
			st = StatFromSys(sys)
		}
	}
	if err == nil && st.Type == Regular && st.Ino == ino && RecencyOf(rel, st) < cutoff {
		if err := r.Remove(private); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return Refused, st, err
		}
		return Removed, st, nil
	}
	// Not the file checked, or used since: put it back, never over a newer one.
	if lerr := r.Link(private, rel); lerr != nil && !errors.Is(lerr, fs.ErrExist) {
		if rerr := r.Rename(private, rel); rerr != nil {
			return Refused, st, rerr
		}
		return Replaced, st, nil
	}
	r.Remove(private)
	if st.Ino == ino {
		return Fresh, st, nil
	}
	return Replaced, st, nil
}

func (c *OS) RemoveTemp(rel string, ino uint64, cutoff int64) (Outcome, Stat, error) {
	if !TempAllowed(rel) {
		return Refused, Stat{}, ErrForbidden
	}
	r, err := c.rootHandle()
	if err != nil {
		return Gone, Stat{}, err
	}
	fi, err := r.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return Gone, Stat{}, nil
	}
	if err != nil {
		return Refused, Stat{}, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return Refused, Stat{}, errNoStat
	}
	st := StatFromSys(sys)
	switch {
	case st.Type != Regular:
		return Refused, st, nil
	case st.Ino != ino:
		return Replaced, st, nil
	case st.Mtime >= cutoff:
		return Fresh, st, nil
	}
	if err := r.Remove(rel); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Gone, st, nil
		}
		return Refused, st, err
	}
	return Removed, st, nil
}

func (c *OS) RemoveEmptyDir(rel string, cutoff int64) (Outcome, error) {
	if !Allowed(rel) {
		return Refused, ErrForbidden
	}
	r, err := c.rootHandle()
	if err != nil {
		return Gone, err
	}
	fi, err := r.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return Gone, nil
	}
	if err != nil {
		return Refused, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return Refused, errNoStat
	}
	st := StatFromSys(sys)
	if st.Type != Dir {
		return Refused, nil
	}
	if st.Recency() >= cutoff {
		return Fresh, nil
	}
	// rmdir fails on a non-empty directory, so a racing go run that refilled
	// it keeps its executable.
	if err := r.Remove(rel); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Gone, nil
		}
		return Refused, err
	}
	return Removed, nil
}

func (c *OS) SetTimes(rel string, ns int64) error {
	if !Allowed(rel) {
		return ErrForbidden
	}
	r, err := c.rootHandle()
	if err != nil {
		return err
	}
	fi, err := r.Lstat(rel)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() && !fi.IsDir() {
		return ErrForbidden
	}
	t := time.Unix(0, ns)
	return r.Chtimes(rel, t, t)
}

func (c *OS) Arm(rel string, atime int64) error {
	if !Allowed(rel) {
		return ErrForbidden
	}
	r, err := c.rootHandle()
	if err != nil {
		return err
	}
	fi, err := r.Lstat(rel)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return ErrForbidden
	}
	return r.Chtimes(rel, time.Unix(0, atime), time.Time{}) // zero mtime: UTIME_OMIT
}

// trimLockTries bounds the wait for Go's shared flock on trim.txt; Go holds it
// for one read, so this never needs long.
const trimLockTries = 20

func (c *OS) WriteTrim(data []byte) error {
	r, err := c.rootHandle()
	if err != nil {
		return err
	}
	if fi, err := r.Lstat("trim.txt"); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("cachefs: trim.txt is not a regular file")
	}
	f, err := r.OpenFile("trim.txt", os.O_RDWR|os.O_CREATE, 0o666)
	if err != nil {
		return err
	}
	defer f.Close()
	fd := int(f.Fd())
	for i := 0; ; i++ {
		err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err == syscall.EWOULDBLOCK && i == trimLockTries {
			return ErrTrimBusy
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			return fmt.Errorf("cachefs: lock trim.txt: %w", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Flock(fd, syscall.LOCK_UN)
	// Same order as cmd/go's lockedfile.Transform: write in place, then cut.
	if _, err := f.WriteAt(data, 0); err != nil {
		return err
	}
	return f.Truncate(int64(len(data)))
}

// LockDir takes an exclusive flock on the directory itself, which writes
// nothing into it. It reports false when another process holds it.
func LockDir(dir string) (release func(), held bool, err error) {
	fd, err := openRetry(dir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC)
	if err != nil {
		return nil, false, err
	}
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err != syscall.EINTR {
			break
		}
	}
	if err == syscall.EWOULDBLOCK {
		syscall.Close(fd)
		return nil, false, nil
	}
	if err != nil {
		syscall.Close(fd)
		return nil, false, err
	}
	return func() { syscall.Close(fd) }, true, nil
}

func openRetry(path string, mode int) (int, error) {
	for {
		fd, err := syscall.Open(path, mode, 0)
		if err != syscall.EINTR {
			return fd, err
		}
	}
}
