package cachefs

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
)

const hex64 = "ab0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"

func TestParseEntryName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
		kind byte
	}{
		{hex64 + "-a", true, 'a'},
		{hex64 + "-d", true, 'd'},
		{strings.ToUpper(hex64[:2]) + hex64[2:] + "-a", false, 0},
		{hex64[:63] + "-a", false, 0},
		{hex64 + "0-a", false, 0},
		{hex64 + "-a.123", false, 0},
		{hex64 + "-d.tmp", false, 0},
		{hex64 + "-x", false, 0},
		{"cd" + hex64[2:] + "-a", false, 0}, // wrong bucket
		{"foo-a", false, 0},
		{"", false, 0},
	}
	for _, c := range cases {
		_, kind, ok := ParseEntryName(0xab, c.name)
		if ok != c.ok || kind != c.kind {
			t.Errorf("ParseEntryName(%q) = %c %v, want %c %v", c.name, kind, ok, c.kind, c.ok)
		}
	}
}

func TestAllowed(t *testing.T) {
	cases := map[string]bool{
		"ab/" + hex64 + "-a":               true,
		"ab/" + hex64 + "-d":               true,
		"ab/" + hex64 + "-d/prog":          true,
		"ab/" + hex64 + "-a/prog":          false,
		"ab/" + hex64 + "-d/x/y":           false,
		"ab/" + hex64 + "-d/..":            false,
		"ab/" + hex64 + "-d/":              false,
		"cd/" + hex64 + "-a":               false,
		"../ab/" + hex64 + "-a":            false,
		"fuzz/ab/" + hex64 + "-d":          false,
		"ab/.DS_Store":                     false,
		"trim.txt":                         false,
		"ab":                               false,
		"AB/" + hex64 + "-a":               false,
		"ab/" + store.TempPrefix + "123.4": false,
		"ab/" + hex64 + "-d/" + "prog/..":  false,
	}
	for rel, want := range cases {
		if got := Allowed(rel); got != want {
			t.Errorf("Allowed(%q) = %v, want %v", rel, got, want)
		}
	}
}

// The sweep accepts exactly the client's temp names (store.ParseTempName),
// directly inside a bucket (amendment 4).
func TestTempAllowed(t *testing.T) {
	for _, rel := range []string{"0f/.pgc-tmp.123.4", "ab/.pgc-tmp.99999.18446744073709551615"} {
		if !TempAllowed(rel) {
			t.Errorf("TempAllowed(%q) false", rel)
		}
	}
	for _, rel := range []string{".pgc-tmp.1.2", "zz/.pgc-tmp.1.2", "0f/x/.pgc-tmp.1.2", "0f", "0f/.pgc-tmp.1", "0f/.pgc-tmp.x.2",
		"0f/.pgc-tmp.1.2.3", "0f/" + hex64 + "-a", "../.pgc-tmp.1.2"} {
		if TempAllowed(rel) {
			t.Errorf("TempAllowed(%q) true", rel)
		}
	}
}

// cache makes a GOCACHE-like dir with bucket ab.
func cache(t *testing.T) (string, *OS) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "ab"), 0o777); err != nil {
		t.Fatal(err)
	}
	return dir, NewOS(dir)
}

func write(t *testing.T, path string, n int, age time.Duration) Stat {
	t.Helper()
	if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, n), 0o666); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	return StatFromSys(&st)
}

func TestRemoveIfIdle(t *testing.T) {
	dir, c := cache(t)
	rel := "ab/" + hex64 + "-d"
	path := filepath.Join(dir, rel)
	now := time.Now().UnixNano()
	st := write(t, path, 100, time.Hour)

	if out, _, _ := c.RemoveIfIdle(rel, st.Ino, now-int64(2*time.Hour)); out != Fresh {
		t.Errorf("used an hour ago, cutoff 2 h: %v", out)
	}
	if out, _, _ := c.RemoveIfIdle(rel, st.Ino+1, now); out != Replaced {
		t.Errorf("other inode: %v", out)
	}
	if out, _, err := c.RemoveIfIdle(rel, st.Ino, now); out != Removed || err != nil {
		t.Fatalf("idle: %v %v", out, err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("file still there")
	}
	if out, _, _ := c.RemoveIfIdle(rel, st.Ino, now); out != Gone {
		t.Errorf("second removal: %v", out)
	}
	if out, _, err := c.RemoveIfIdle("ab/.DS_Store", 1, now); out != Refused || !errors.Is(err, ErrForbidden) {
		t.Errorf("unmanaged name: %v %v", out, err)
	}
	// An -a's recency is its mtime only: a read doesn't keep it.
	arel := "ab/" + hex64 + "-a"
	ast := write(t, filepath.Join(dir, arel), 175, 3*time.Hour)
	os.Chtimes(filepath.Join(dir, arel), time.Now(), time.Now().Add(-3*time.Hour))
	if out, _, _ := c.RemoveIfIdle(arel, ast.Ino, now-int64(2*time.Hour)); out != Removed {
		t.Errorf("-a with a fresh atime but a 3 h mtime: %v", out)
	}
}

func TestRemoveRefusesSpecialFiles(t *testing.T) {
	dir, c := cache(t)
	now := time.Now().UnixNano()
	fifo := "ab/" + hex64 + "-a"
	if err := syscall.Mkfifo(filepath.Join(dir, fifo), 0o666); err != nil {
		t.Fatal(err)
	}
	var st syscall.Stat_t
	syscall.Lstat(filepath.Join(dir, fifo), &st)
	if out, _, _ := c.RemoveIfIdle(fifo, st.Ino, now); out != Refused {
		t.Errorf("FIFO: %v", out)
	}
	done := make(chan struct{})
	go func() {
		c.ReadPrefix(fifo, make([]byte, 64))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ReadPrefix blocked on a FIFO")
	}
	victim := filepath.Join(t.TempDir(), "victim")
	write(t, victim, 1000, 0)
	link := "ab/" + hex64 + "-d"
	if err := os.Symlink(victim, filepath.Join(dir, link)); err != nil {
		t.Fatal(err)
	}
	syscall.Lstat(filepath.Join(dir, link), &st)
	if out, _, _ := c.RemoveIfIdle(link, st.Ino, now); out != Refused {
		t.Errorf("symlink: %v", out)
	}
	if err := c.SetTimes(link, now); !errors.Is(err, ErrForbidden) {
		t.Errorf("SetTimes through a symlink: %v", err)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Errorf("symlink target harmed: %v", err)
	}
}

// A bucket that is a symlink out of the cache is never followed.
func TestSymlinkedBucket(t *testing.T) {
	dir, c := cache(t)
	outside := t.TempDir()
	st := write(t, filepath.Join(outside, "cd"+hex64[2:]+"-a"), 175, 3*time.Hour)
	if err := os.Symlink(outside, filepath.Join(dir, "cd")); err != nil {
		t.Fatal(err)
	}
	rel := "cd/cd" + hex64[2:] + "-a"
	if names, err := c.ReadDirNames("cd"); err == nil {
		t.Errorf("listed a symlinked bucket: %v", names)
	}
	if out, _, _ := c.RemoveIfIdle(rel, st.Ino, time.Now().UnixNano()); out == Removed {
		t.Error("removed through a symlinked bucket")
	}
	if _, err := os.Stat(filepath.Join(outside, "cd"+hex64[2:]+"-a")); err != nil {
		t.Errorf("file outside the cache harmed: %v", err)
	}
}

// S19: permissions and flags refuse removal with an error, never a panic.
func TestRemoveRefusedByPermissions(t *testing.T) {
	dir, c := cache(t)
	now := time.Now().UnixNano()
	rel := "ab/" + hex64 + "-d"
	path := filepath.Join(dir, rel)
	st := write(t, path, 100, 3*time.Hour)
	os.Chmod(filepath.Join(dir, "ab"), 0o555)
	t.Cleanup(func() { os.Chmod(filepath.Join(dir, "ab"), 0o777) })
	if out, _, err := c.RemoveIfIdle(rel, st.Ino, now); out != Refused || err == nil {
		t.Errorf("chmod 555 bucket: %v %v", out, err)
	}
	os.Chmod(filepath.Join(dir, "ab"), 0o777)
	const ufImmutable = 0x2 // UF_IMMUTABLE (chflags uchg)
	if err := syscall.Chflags(path, ufImmutable); err != nil {
		t.Skipf("chflags: %v", err)
	}
	t.Cleanup(func() { syscall.Chflags(path, 0) })
	if out, _, err := c.RemoveIfIdle(rel, st.Ino, now); out != Refused || err == nil {
		t.Errorf("uchg: %v %v", out, err)
	}
}

func TestRemoveEmptyDir(t *testing.T) {
	dir, c := cache(t)
	rel := "ab/" + hex64 + "-d"
	path := filepath.Join(dir, rel)
	os.Mkdir(path, 0o777)
	write(t, filepath.Join(path, "prog"), 10, time.Hour)
	old := time.Now().Add(-3 * time.Hour)
	os.Chtimes(path, old, old)
	now := time.Now().UnixNano()
	if out, err := c.RemoveEmptyDir(rel, now); out != Refused || err == nil {
		t.Errorf("non-empty: %v %v", out, err)
	}
	os.Remove(filepath.Join(path, "prog"))
	if out, _ := c.RemoveEmptyDir(rel, now-int64(time.Hour)); out != Fresh {
		t.Errorf("just emptied, so its mtime is now: %v", out)
	}
	if out, err := c.RemoveEmptyDir(rel, time.Now().Add(time.Second).UnixNano()); out != Removed || err != nil {
		t.Errorf("empty: %v %v", out, err)
	}
}

// Arming lowers only atime, and APFS then records the next read in atime:
// what keeps a queued output that something reads before its removal.
func TestArmMakesReadsVisible(t *testing.T) {
	dir, c := cache(t)
	rel := "ab/" + hex64 + "-d"
	path := filepath.Join(dir, rel)
	st := write(t, path, 5000, 2*time.Hour)
	if err := c.Arm(rel, st.Mtime-int64(time.Second)); err != nil {
		t.Fatal(err)
	}
	after, _ := c.Lstat(rel)
	if after.Mtime != st.Mtime || after.Atime != st.Mtime-int64(time.Second) {
		t.Fatalf("arm: mtime %d->%d atime %d", st.Mtime, after.Mtime, after.Atime)
	}
	if _, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
	read, _ := c.Lstat(rel)
	if read.Atime <= st.Mtime {
		t.Fatalf("a read after arming left atime at %d (mtime %d): this volume doesn't update atime", read.Atime, st.Mtime)
	}
}

// S15b: Go reads trim.txt under a shared flock while the daemon rewrites it;
// every read is a whole integer near now.
func TestWriteTrimConcurrentReaders(t *testing.T) {
	dir, c := cache(t)
	path := filepath.Join(dir, "trim.txt")
	c.WriteTrim([]byte(strconv.FormatInt(time.Now().Unix(), 10)))
	var wg sync.WaitGroup
	stop := make(chan struct{})
	var bad []string
	var mu sync.Mutex
	reads := 0
	for r := 0; r < 8; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 1250; n++ { // 10k reads in all, as in S15b
				select {
				case <-stop:
					return
				default:
				}
				time.Sleep(50 * time.Microsecond)
				f, err := os.Open(path)
				if err != nil {
					continue
				}
				syscall.Flock(int(f.Fd()), syscall.LOCK_SH)
				var buf [64]byte
				n, _ := f.ReadAt(buf[:], 0)
				f.Close()
				v, err := strconv.ParseInt(string(buf[:n]), 10, 64)
				mu.Lock()
				reads++
				if err != nil || v > time.Now().Unix()+1 || v < time.Now().Unix()-3600 {
					bad = append(bad, string(buf[:n]))
				}
				mu.Unlock()
			}
		}()
	}
	failed := 0
	for i := 0; i < 1000; i++ {
		// Alternate widths so a torn write would show.
		v := time.Now().Unix() - int64(i%2)*3000
		if err := c.WriteTrim([]byte(strconv.FormatInt(v, 10))); err != nil {
			failed++
		}
		time.Sleep(100 * time.Microsecond)
	}
	wg.Wait()
	close(stop)
	if len(bad) > 0 {
		t.Fatalf("%d of %d reads were not a whole recent integer, first %q", len(bad), reads, bad[0])
	}
	if failed > 50 {
		t.Errorf("%d of 1000 writes failed to get the lock", failed)
	}
	t.Logf("%d reads, %d writes failed", reads, failed)
}

func TestWriteTrimRefusesNonRegular(t *testing.T) {
	dir, c := cache(t)
	os.Mkdir(filepath.Join(dir, "trim.txt"), 0o777)
	if err := c.WriteTrim([]byte("1")); err == nil {
		t.Error("wrote into a directory named trim.txt")
	}
	os.Remove(filepath.Join(dir, "trim.txt"))
	victim := filepath.Join(t.TempDir(), "v")
	write(t, victim, 3, 0)
	os.Symlink(victim, filepath.Join(dir, "trim.txt"))
	if err := c.WriteTrim([]byte("1")); err == nil {
		t.Error("wrote through a symlinked trim.txt")
	}
	if data, _ := os.ReadFile(victim); string(data) != "xxx" {
		t.Errorf("symlink target changed to %q", data)
	}
}

// S25: the cache-dir lock lets one owner act; it writes nothing into the dir.
func TestLockDir(t *testing.T) {
	dir, _ := cache(t)
	before, _ := os.ReadDir(dir)
	rel1, held, err := LockDir(dir)
	if err != nil || !held {
		t.Fatalf("first lock: %v %v", held, err)
	}
	if _, held2, _ := LockDir(dir); held2 {
		t.Error("second lock held too")
	}
	rel1()
	rel3, held3, _ := LockDir(dir)
	if !held3 {
		t.Error("lock not free after release")
	}
	rel3()
	if after, _ := os.ReadDir(dir); len(after) != len(before) {
		t.Errorf("locking wrote into the cache dir: %d -> %d names", len(before), len(after))
	}
}

// A put that renames a fresh copy over an output right after the daemon's
// check (its link-only wait ran out) must keep its file: the removal takes
// away only the file it checked and puts the fresh copy back under its name.
func TestRemoveIfIdleKeepsAFileRenamedOverAfterTheCheck(t *testing.T) {
	dir, c := cache(t)
	rel := "ab/" + hex64 + "-d"
	path := filepath.Join(dir, rel)
	old := write(t, path, 100, 3*time.Hour)
	fresh := filepath.Join(dir, "ab", store.TempPrefix+"1.1")
	write(t, fresh, 100, 0)
	beforeRemove = func(string) {
		if err := os.Rename(fresh, path); err != nil {
			t.Error(err)
		}
	}
	defer func() { beforeRemove = nil }()
	out, _, err := c.RemoveIfIdle(rel, old.Ino, time.Now().Add(-time.Hour).UnixNano())
	if err != nil || out != Replaced {
		t.Errorf("outcome %v %v, want Replaced", out, err)
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		t.Fatalf("the fresh output was removed: %v", err)
	}
	if st.Ino == old.Ino {
		t.Error("the old output is back")
	}
	names, _ := os.ReadDir(filepath.Join(dir, "ab"))
	if len(names) != 1 {
		t.Errorf("bucket holds %d names, want only the output", len(names))
	}
}
