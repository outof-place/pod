package ownerstate

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"os"
)

// ModeKey identifies one version of the mode file, to notice changes cheaply.
type ModeKey struct {
	Exists bool
	Ino    uint64
	Mtime  int64
	Size   int64
}

// StatMode returns the mode file's identity without reading it.
func StatMode(dir string) ModeKey {
	var st syscall.Stat_t
	if syscall.Lstat(filepath.Join(dir, ModeFile), &st) != nil {
		return ModeKey{}
	}
	return ModeKey{Exists: true, Ino: st.Ino, Mtime: st.Mtimespec.Nano(), Size: st.Size}
}

// maxModeBytes bounds the read: the only valid contents are two short words.
const maxModeBytes = 64

// ReadMode reads the switch. Only a regular file whose trimmed content is
// "owner" asks for owner mode; anything else is observe, with the reason.
// valid is false when the content was neither word (a half-written file
// reads empty, so callers confirm such a change before acting on it).
func ReadMode(dir string) (mode string, valid bool, reason string) {
	path := filepath.Join(dir, ModeFile)
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return ModeObserve, true, "no mode file"
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return ModeObserve, false, "mode file is not a regular file"
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return ModeObserve, false, "mode file unreadable: " + err.Error()
	}
	defer syscall.Close(fd)
	var buf [maxModeBytes + 1]byte
	n, err := syscall.Read(fd, buf[:])
	if err != nil {
		return ModeObserve, false, "mode file unreadable: " + err.Error()
	}
	if n > maxModeBytes {
		return ModeObserve, false, "mode file too long"
	}
	switch v := strings.TrimSpace(string(buf[:n])); v {
	case ModeOwner:
		return ModeOwner, true, "mode file says owner"
	case ModeObserve:
		return ModeObserve, true, "mode file says observe"
	case "":
		return ModeObserve, false, "mode file is empty"
	default:
		if len(v) > 16 {
			v = v[:16]
		}
		return ModeObserve, false, fmt.Sprintf("mode file says %q, not owner or observe", v)
	}
}

// RecordStart adds this start to the crash-loop record (starts the previous
// runs did not clear by exiting cleanly) and returns how many fall within
// window, this one included.
func RecordStart(dir string, now time.Time, pid int, window time.Duration) (int, error) {
	kept := readStarts(dir, now, window)
	kept = append(kept, fmt.Sprintf("%d %d", now.Unix(), pid))
	return len(kept), WriteAtomic(dir, StartFile, []byte(strings.Join(kept, "\n")+"\n"))
}

// ClearStart removes this run's record on a clean exit.
func ClearStart(dir string, pid int) error {
	data, err := os.ReadFile(filepath.Join(dir, StartFile))
	if err != nil {
		return nil
	}
	var kept []string
	suffix := " " + strconv.Itoa(pid)
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if l != "" && !strings.HasSuffix(l, suffix) {
			kept = append(kept, l)
		}
	}
	if len(kept) == 0 {
		return os.Remove(filepath.Join(dir, StartFile))
	}
	return WriteAtomic(dir, StartFile, []byte(strings.Join(kept, "\n")+"\n"))
}

// ResetStarts forgets every record, so the next launch gets a fresh chance.
func ResetStarts(dir string) error {
	err := os.Remove(filepath.Join(dir, StartFile))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// recentStarts counts unclean starts within window.
func recentStarts(dir string, now time.Time, window time.Duration) int {
	return len(readStarts(dir, now, window))
}

func readStarts(dir string, now time.Time, window time.Duration) []string {
	data, err := os.ReadFile(filepath.Join(dir, StartFile))
	if err != nil {
		return nil
	}
	var kept []string
	for _, l := range strings.Split(string(data), "\n") {
		f := strings.Fields(l)
		if len(f) != 2 {
			continue
		}
		at, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			continue
		}
		if age := now.Sub(time.Unix(at, 0)); age >= 0 && age < window {
			kept = append(kept, l)
		}
	}
	return kept
}
