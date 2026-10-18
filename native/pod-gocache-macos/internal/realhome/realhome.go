// Package realhome lets a test harness show that it left the user's real Pod
// state and Go cache alone (S9, G3): Take a snapshot before the tests and
// Check it after.
package realhome

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

type stamp struct {
	ino          uint64
	size         int64
	mtime, ctime syscall.Timespec
}

// Snapshot is the stat of every file a stray default path could touch: the
// entries of ~/.pod/gocache and its bin, of the default shared-state root,
// and the real cache's trim.txt.
type Snapshot struct {
	home  string
	files map[string]stamp
}

// Take snapshots home; an empty home gives an empty snapshot.
func Take(home string) Snapshot {
	s := Snapshot{home: home, files: map[string]stamp{}}
	if home == "" {
		return s
	}
	for _, dir := range []string{s.stateDir(), filepath.Join(s.stateDir(), "bin"), filepath.Join(home, "Library", "Caches", "pod-gocache")} {
		names, _ := os.ReadDir(dir)
		for _, n := range names {
			if !strings.HasPrefix(n.Name(), ".") || !strings.Contains(n.Name(), ".tmp.") { // the live daemon's atomic writes
				s.add(filepath.Join(dir, n.Name()))
			}
		}
	}
	s.add(s.trimFile())
	return s
}

func (s Snapshot) stateDir() string { return filepath.Join(s.home, ".pod", "gocache") }
func (s Snapshot) trimFile() string {
	return filepath.Join(s.home, "Library", "Caches", "go-build", "trim.txt")
}

func (s Snapshot) add(p string) {
	var st syscall.Stat_t
	switch {
	case syscall.Lstat(p, &st) != nil:
	case st.Mode&syscall.S_IFMT == syscall.S_IFDIR:
		s.files[p] = stamp{ino: st.Ino} // its entries are stamped on their own
	default:
		s.files[p] = stamp{st.Ino, st.Size, st.Mtimespec, st.Ctimespec}
	}
}

// Check lists every path that appeared, went or changed since s, apart from
// what the live daemon rewrites on its own: owner.json, state.json and
// daemon.log (and its .1) when they don't mention any of tmp, where the
// tests keep their caches and state directories, and trim.txt when it holds
// the time state.json says the daemon wrote it.
func (s Snapshot) Check(tmp ...string) []string {
	now := Take(s.home)
	var out []string
	for p, before := range s.files {
		after, ok := now.files[p]
		switch {
		case !ok:
			out = append(out, p+" went")
		case after != before && !s.daemonWrote(p, tmp):
			out = append(out, fmt.Sprintf("%s changed (inode %d, size %d -> inode %d, size %d)", p, before.ino, before.size, after.ino, after.size))
		}
	}
	for p := range now.files {
		if _, ok := s.files[p]; !ok && !s.daemonWrote(p, tmp) {
			out = append(out, p+" appeared")
		}
	}
	slices.Sort(out)
	return out
}

func (s Snapshot) daemonWrote(p string, tmp []string) bool {
	if p == s.trimFile() {
		st, ok, _ := ownerstate.ReadState(s.stateDir())
		data, err := os.ReadFile(p)
		return ok && err == nil && st.Extra.TrimWrittenAt != 0 && strings.TrimSpace(string(data)) == strconv.FormatInt(st.Extra.TrimWrittenAt, 10)
	}
	if filepath.Dir(p) != s.stateDir() {
		return false
	}
	switch filepath.Base(p) {
	case ownerstate.OwnerFile, ownerstate.StateFile, ownerstate.LogFile, ownerstate.LogFile + ".1":
	default:
		return false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	for _, t := range tmp {
		if t != "" && strings.Contains(string(data), t) {
			return false
		}
	}
	return true
}

// Run runs a test binary's tests and fails them when they changed the user's
// real Pod state or Go cache under home.
func Run(m interface{ Run() int }, home string) int {
	snap := Take(home)
	code := m.Run()
	if changed := snap.Check(TempRoots()...); len(changed) > 0 {
		fmt.Fprintf(os.Stderr, "FAIL: the tests changed the real Pod state or Go cache:\n\t%s\n", strings.Join(changed, "\n\t"))
		return 1
	}
	return code
}

// TempRoots are the spellings of the temp directory tests write under.
func TempRoots() []string {
	t := filepath.Clean(os.TempDir())
	roots := []string{t}
	if r, err := filepath.EvalSymlinks(t); err == nil && r != t {
		roots = append(roots, r)
	}
	return roots
}
