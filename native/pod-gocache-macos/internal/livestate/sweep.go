package livestate

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// CleanTemps removes the .index.<pid>.<gen> and .clients.<pid> files a
// daemon that died mid-write left in dir, and returns their names. A file of
// a live pid is left alone: that daemon may be writing it now.
func CleanTemps(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var removed []string
	for _, e := range ents {
		pid, ok := tempPID(e.Name())
		if !ok || pidAlive(pid) {
			continue
		}
		if syscall.Unlink(filepath.Join(dir, e.Name())) == nil {
			removed = append(removed, e.Name())
		}
	}
	return removed
}

// tempPID parses the writer's pid out of a temp file name.
func tempPID(name string) (int, bool) {
	var rest string
	switch {
	case strings.HasPrefix(name, ".index."):
		rest, _, _ = strings.Cut(name[len(".index."):], ".")
	case strings.HasPrefix(name, ".clients."):
		rest = name[len(".clients."):]
	default:
		return 0, false
	}
	pid, err := strconv.Atoi(rest)
	return pid, err == nil && pid > 0
}

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// SweepStale removes the live directories under root other than keep whose
// cache directory no longer exists, that no daemon publishes (the publisher
// lock is free) and no client uses (no slot is locked). It returns the
// directories removed. Anything it cannot be sure of stays.
func SweepStale(root, keep string) []string {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var removed []string
	for _, e := range ents {
		dir := filepath.Join(root, e.Name())
		if dir == keep || !e.IsDir() {
			continue
		}
		id, ok := parseDirName(e.Name())
		if !ok || cacheMayExist(id) {
			continue
		}
		if removeUnused(dir) {
			removed = append(removed, dir)
		}
	}
	return removed
}

// parseDirName reads the cache identity out of v1-<dev hex>-<ino hex>.
func parseDirName(name string) (CacheID, bool) {
	rest, ok := strings.CutPrefix(name, dirPrefix)
	if !ok {
		return CacheID{}, false
	}
	d, i, ok := strings.Cut(rest, "-")
	if !ok {
		return CacheID{}, false
	}
	dev, err1 := strconv.ParseUint(d, 16, 64)
	ino, err2 := strconv.ParseUint(i, 16, 64)
	return CacheID{Dev: dev, Ino: ino}, err1 == nil && err2 == nil
}

// cacheMayExist looks the directory up by device and inode through /.vol.
// Only a volume that is mounted (its root, inode 2, answers) and answers
// ENOENT for the inode counts as gone; an unmounted disk or any other error
// keeps the directory.
func cacheMayExist(id CacheID) bool {
	vol := "/.vol/" + strconv.FormatUint(id.Dev, 10)
	var st syscall.Stat_t
	if syscall.Stat(vol+"/2", &st) != nil {
		return true
	}
	err := syscall.Stat(vol+"/"+strconv.FormatUint(id.Ino, 10), &st)
	return err != syscall.ENOENT
}

// removeUnused deletes dir's files and dir itself while holding its
// publisher lock, after checking no client slot is locked.
func removeUnused(dir string) bool {
	fd, err := syscall.Open(filepath.Join(dir, PublisherLockName), syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil && err != syscall.ENOENT {
		return false
	}
	if err == nil {
		defer syscall.Close(fd)
		if syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			return false
		}
	}
	if slotsHeld(filepath.Join(dir, ClientsName)) {
		return false
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if !e.Type().IsRegular() {
			return false // not ours: leave the whole directory
		}
	}
	for _, e := range ents {
		syscall.Unlink(filepath.Join(dir, e.Name()))
	}
	return syscall.Rmdir(dir) == nil
}

// slotsHeld reports whether any client holds a slot of the clients file at
// path (or it cannot tell). No file means no client.
func slotsHeld(path string) bool {
	// F_GETLK of a write lock needs a descriptor open for writing.
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err == syscall.ENOENT {
		return false
	}
	if err != nil {
		return true
	}
	defer syscall.Close(fd)
	for i := range SlotCount {
		if pid, err := lockByte(fd, syscall.F_GETLK, slotLockOffset(i)); err != nil || pid != 0 {
			return true
		}
	}
	return false
}
