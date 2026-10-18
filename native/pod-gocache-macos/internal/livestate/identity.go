package livestate

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	_ "unsafe" // runtime.nanotime
)

// EnvRoot overrides the root of the live directories (tests, harnesses).
const EnvRoot = "POD_GOCACHE_LIVE_DIR"

// CacheID identifies a cache directory by the device and inode of the
// directory itself.
type CacheID struct{ Dev, Ino uint64 }

// StatCache returns the identity of dir, following symlinks.
func StatCache(dir string) (CacheID, bool) {
	var st syscall.Stat_t
	for {
		err := syscall.Stat(dir, &st)
		if err == syscall.EINTR {
			continue
		}
		if err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			return CacheID{}, false
		}
		return CacheID{Dev: uint64(uint32(st.Dev)), Ino: st.Ino}, true
	}
}

// Root is where live directories go: $POD_GOCACHE_LIVE_DIR when it is an
// absolute path, else ~/Library/Caches/pod-gocache/live (Time Machine skips
// ~/Library/Caches, and these files change on every build).
func Root() (string, bool) {
	if r := os.Getenv(EnvRoot); r != "" {
		return filepath.Clean(r), filepath.IsAbs(r)
	}
	home := os.Getenv("HOME")
	if home == "" || !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, "Library", "Caches", "pod-gocache", "live"), true
}

// Dir is the live directory of the cache id under root.
func Dir(root string, id CacheID) string {
	return filepath.Join(root, dirPrefix+strconv.FormatUint(id.Dev, 16)+"-"+strconv.FormatUint(id.Ino, 16))
}

// BootID is this boot's session UUID (kern.bootsessionuuid) as 16 bytes; the
// zero value when it can't be read.
func BootID() [16]byte {
	var id [16]byte
	s, err := syscall.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return id
	}
	n := 0
	for i := 0; i+1 < len(s) && n < 16; {
		hi, ok1 := hexNibble(s[i])
		if !ok1 {
			i++
			continue
		}
		lo, ok2 := hexNibble(s[i+1])
		if !ok2 {
			i++
			continue
		}
		id[n] = hi<<4 | lo
		n++
		i += 2
	}
	return id
}

func hexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// The runtime keeps this linkname working for outside packages (go.dev/issue/67401).
//
//go:linkname nanotime runtime.nanotime
func nanotime() int64

// AwakeNow is awake time since boot (mach_absolute_time: it stops while the
// Mac sleeps), the same clock in every process of one boot.
func AwakeNow() int64 { return nanotime() }

func wallNow() int64 { return time.Now().UnixNano() }
