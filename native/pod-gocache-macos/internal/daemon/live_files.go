package daemon

import (
	"errors"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"slices"
	"syscall"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// fileShared is Shared over the livestate files in
// <root>/v1-<dev>-<ino of the cache directory>/.
type fileShared struct {
	root, cacheDir string
	dir            string
	id             livestate.CacheID
	boot           [16]byte
	lockFD         int
	lockID         livestate.FileID
	gen            uint64
	idx            *livestate.IndexWriter
	// cli holds the clients files still mapped, oldest first; the last is
	// current. An older one stays while clients that claimed a slot in it
	// before it was deleted or replaced may still live.
	cli  []*livestate.Clients
	logf func(format string, a ...any)
}

func newFileShared(root, cacheDir string) *fileShared {
	return &fileShared{root: root, cacheDir: cacheDir, lockFD: -1, boot: livestate.BootID()}
}

func (f *fileShared) Where() string { return f.dir }

func (f *fileShared) log(format string, a ...any) {
	if f.logf != nil {
		f.logf(format, a...)
	}
}

func (f *fileShared) Open() error {
	f.Close()
	id, ok := livestate.StatCache(f.cacheDir)
	if !ok {
		return errors.New("cache directory missing")
	}
	f.id, f.dir = id, livestate.Dir(f.root, id)
	if err := f.lock(); err != nil {
		return err
	}
	for _, name := range livestate.CleanTemps(f.dir) {
		f.log("removed %s/%s left by a dead daemon", f.dir, name)
	}
	for _, dir := range livestate.SweepStale(f.root, f.dir) {
		f.log("removed %s: its cache directory is gone and nothing uses it", dir)
	}
	c, err := livestate.OpenClients(f.dir, id, f.boot)
	if err != nil {
		f.Close()
		return fmt.Errorf("clients file: %w", err)
	}
	f.cli = []*livestate.Clients{c}
	return nil
}

// lock creates the live directory if needed and takes its publisher lock,
// letting go of a lock held on a file that is no longer there.
func (f *fileShared) lock() error {
	if err := privateDir(f.root); err != nil {
		return err
	}
	if err := privateDir(f.dir); err != nil {
		return err
	}
	fd, err := syscall.Open(filepath.Join(f.dir, livestate.PublisherLockName), syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return fmt.Errorf("publisher lock: %w", err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		syscall.Close(fd)
		if err == syscall.EWOULDBLOCK {
			return ErrOtherPublisher
		}
		return fmt.Errorf("publisher lock: %w", err)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return fmt.Errorf("publisher lock: %w", err)
	}
	if f.lockFD >= 0 {
		syscall.Close(f.lockFD)
	}
	f.lockFD, f.lockID = fd, livestate.FileID{Dev: uint64(uint32(st.Dev)), Ino: st.Ino, Size: st.Size}
	return nil
}

// Check compares what the live directory holds now with the files mapped:
// "" while they are the same, else what changed (a file deleted, replaced or
// cut short under the daemon, the directory removed).
func (f *fileShared) Check() string {
	if err := livestate.PathIs(filepath.Join(f.dir, livestate.PublisherLockName), f.lockID); err != nil {
		return "publisher lock: " + err.Error()
	}
	if c := f.current(); c != nil {
		if err := livestate.PathIs(c.Path(), c.Identity()); err != nil {
			return "clients file: " + err.Error()
		}
	}
	if f.idx != nil {
		if err := livestate.PathIs(f.idx.Path(), f.idx.Identity()); err != nil {
			return "index: " + err.Error()
		}
	}
	return ""
}

// Repair puts back what Check found missing or changed: the directory and
// the lock, a new current clients file (the old mapping stays, for the
// clients that hold slots in it), and a new index when the published one is
// not the daemon's. reindexed says the caller must publish every entry again.
func (f *fileShared) Repair(entries int) (reindexed bool, err error) {
	lockBad := livestate.PathIs(filepath.Join(f.dir, livestate.PublisherLockName), f.lockID) != nil
	if lockBad {
		if err := f.lock(); err != nil {
			return false, err
		}
	}
	if c := f.current(); c == nil || livestate.PathIs(c.Path(), c.Identity()) != nil {
		next, err := livestate.OpenClients(f.dir, f.id, f.boot)
		if err != nil {
			return false, fmt.Errorf("clients file: %w", err)
		}
		f.cli = append(f.cli, next)
	}
	if f.idx == nil || livestate.PathIs(f.idx.Path(), f.idx.Identity()) != nil {
		return true, f.Reset(entries)
	}
	return false, nil
}

func (f *fileShared) current() *livestate.Clients {
	if len(f.cli) == 0 {
		return nil
	}
	return f.cli[len(f.cli)-1]
}

func (f *fileShared) Gens() int { return len(f.cli) }

// Retire unmaps older clients file g.
func (f *fileShared) Retire(g int) {
	if g < 0 || g >= len(f.cli)-1 {
		return
	}
	f.cli[g].Close()
	f.cli = slices.Delete(f.cli, g, g+1)
}

// privateDir creates dir 0700, or accepts an existing one that is a real
// directory of this user; a group or world bit is taken away.
func privateDir(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(dir, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("%s is not a directory of this user", dir)
	}
	if st.Mode&0o077 != 0 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}

func (f *fileShared) Close() {
	if f.idx != nil {
		f.idx.Close()
		f.idx = nil
	}
	for _, c := range f.cli {
		c.Close()
	}
	f.cli = nil
	if f.lockFD >= 0 {
		syscall.Close(f.lockFD)
		f.lockFD = -1
	}
}

// slotsFor sizes a table for entries at about 40% load (rebuilt at 45%).
func slotsFor(entries int) int {
	n := max(entries*5/2, 1<<12)
	return min(1<<bits.Len(uint(n-1)), 1<<22)
}

func (f *fileShared) Reset(entries int) error {
	f.gen++
	w, err := livestate.CreateIndex(f.dir, f.id, slotsFor(entries), f.gen, f.boot)
	if err != nil {
		return err
	}
	if f.idx != nil {
		// Readers of the old file move over; for a file replaced under the
		// daemon, the rename above did not reach them.
		f.idx.Supersede()
		f.idx.Close()
	}
	f.idx = w
	return nil
}

// Sync writes the index's informational counters, once per publishing round.
func (f *fileShared) Sync() {
	if f.idx != nil {
		f.idx.SyncLive()
	}
}

func (f *fileShared) Publish(id index.ID, e index.Exact) bool {
	return f.idx.Put(&id, &livestate.Entry{Output: e.Out, Size: e.Size, Time: e.Time, Ino: e.Ino, Ctime: e.Ctime, Mtime: e.Mtime})
}

func (f *fileShared) Unpublish(id index.ID) { f.idx.Delete(&id) }

func (f *fileShared) Crowded() bool {
	return f.idx.Crowded() && f.idx.Slots() < 1<<22
}

func (f *fileShared) IndexStats() (entries, slots, full int) {
	if f.idx == nil {
		return 0, 0, 0
	}
	return f.idx.Live(), f.idx.Slots(), f.idx.Full
}

func (f *fileShared) Slot(g, i int, v *livestate.SlotView) bool { return f.cli[g].Slot(i, v) }

// Alive treats a failed query as alive: a pin then lasts until its expiry
// rather than going early.
func (f *fileShared) Alive(g, i int) bool {
	pid, err := f.cli[g].Holder(i)
	return err != nil || pid != 0
}

// liveRoot is where the daemon publishes: --live-dir, else
// $POD_GOCACHE_LIVE_DIR (clients read the same variable), else <state
// dir>/live for a non-default state directory (a test or second daemon
// stays out of the real one), else ~/Library/Caches/pod-gocache/live.
func liveRoot(cfg Config) (string, bool) {
	switch cfg.LiveRoot {
	case "off":
		return "", false
	case "":
	default:
		return filepath.Clean(cfg.LiveRoot), filepath.IsAbs(cfg.LiveRoot)
	}
	if r := os.Getenv(livestate.EnvRoot); r != "" {
		return livestate.Root()
	}
	if def, err := DefaultStateDir(); err == nil && filepath.Clean(cfg.StateDir) != def {
		return filepath.Join(cfg.StateDir, "live"), true
	}
	return livestate.Root()
}

func (f *fileShared) Records(g, i int, from, to uint64, dst []livestate.Record) ([]livestate.Record, bool) {
	return f.cli[g].Records(i, from, to, dst)
}

// BeginDying and EndDying write every clients file still mapped: a client of
// an older one reads its batches there. Only the current one's failure
// counts; an older one cut short has no reader left to protect.
func (f *fileShared) BeginDying(prefixes []uint64) bool {
	for _, c := range f.cli[:len(f.cli)-1] {
		c.BeginDying(prefixes)
	}
	return f.current().BeginDying(prefixes)
}

func (f *fileShared) EndDying() bool {
	for _, c := range f.cli[:len(f.cli)-1] {
		c.EndDying()
	}
	return f.current().EndDying()
}

func (f *fileShared) Heartbeat(wallNs int64) { f.current().Heartbeat(wallNs) }
