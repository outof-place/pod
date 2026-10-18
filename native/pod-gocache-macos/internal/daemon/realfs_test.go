package daemon

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// S9: observe mode writes nothing into the cache directory, at the hard
// floor with a budget of one byte, while the mode file goes observe ->
// garbage -> missing. Then owner mode changes only what it removes, plus
// trim.txt.
func TestS9ObserveWritesNothing(t *testing.T) {
	dir := tempDir(t)
	for i := 0; i < 256; i++ {
		os.Mkdir(filepath.Join(dir, cachefs.BucketName(i)), 0o777)
	}
	var old, fresh []entryIDs
	for i := 0; i < 1500; i++ {
		old = append(old, putEntry(t, dir, 3000, 2*time.Hour+time.Duration(i)*time.Second))
	}
	for i := 0; i < 100; i++ {
		fresh = append(fresh, putEntry(t, dir, 3000, 0))
	}
	gone := map[string]bool{"7d": true, "a0": true, "ff": true}
	for b := range gone {
		os.RemoveAll(filepath.Join(dir, b))
	}
	keep := func(es []entryIDs) []entryIDs {
		var out []entryIDs
		for _, e := range es {
			if a, d := e.paths(dir); exists(a) && exists(d) {
				out = append(out, e)
			}
		}
		return out
	}
	old, fresh = keep(old), keep(fresh)
	os.MkdirAll(filepath.Join(dir, "fuzz", "pkg"), 0o777)
	os.WriteFile(filepath.Join(dir, "fuzz", "pkg", "seed"), []byte("x"), 0o666)
	os.WriteFile(filepath.Join(dir, "testexpire.txt"), []byte("1\n"), 0o666)
	before := snapshot(t, dir)

	cfg := fastConfig(t, dir, 5_000_000_000)
	setMode(t, cfg.StateDir, "observe")
	stop := startRun(t, cfg)
	for _, m := range []string{"observe", "garbage", ""} {
		setMode(t, cfg.StateDir, m)
		time.Sleep(10 * cfg.Tick * 3)
	}
	waitFor(t, time.Minute, "indexing", func() bool { return readState(t, cfg.StateDir).Extra.Phase == "ready" })
	time.Sleep(10 * cfg.Tick)
	if a, r, c := diffSnap(before, snapshot(t, dir)); len(a)+len(r)+len(c) > 0 {
		t.Fatalf("observe mode changed the cache: added %v removed %d changed %v", a, len(r), c[:min(5, len(c))])
	}
	if st := readState(t, cfg.StateDir); st.WouldEvictBytes == nil || *st.WouldEvictBytes == 0 {
		t.Errorf("observe published no plan: %+v", st.WouldEvictBytes)
	}

	setMode(t, cfg.StateDir, "owner")
	waitFor(t, time.Minute, "owner mode to evict the old entries", func() bool {
		for _, e := range old {
			if a, d := e.paths(dir); exists(a) || exists(d) {
				return false
			}
		}
		return true
	})
	time.Sleep(20 * cfg.Tick)
	stop()
	added, removed, changed := diffSnap(before, snapshot(t, dir))
	if !slices.Equal(added, []string{"trim.txt"}) {
		t.Errorf("owner mode added %v, want only trim.txt", added)
	}
	young := map[string]bool{}
	for _, e := range fresh {
		a, d := e.paths(dir)
		ra, _ := filepath.Rel(dir, a)
		rd, _ := filepath.Rel(dir, d)
		young[ra], young[rd] = true, true
	}
	for _, r := range removed {
		if young[r] || !cachefs.Allowed(r) {
			t.Errorf("owner mode removed %s", r)
		}
	}
	for _, c := range changed {
		if !(len(c) == 2) { // bucket directories change when entries go
			t.Errorf("owner mode changed %s", c)
		}
	}
	for _, e := range fresh {
		if a, d := e.paths(dir); !exists(a) || !exists(d) {
			t.Fatalf("a fresh entry was removed:\n%s", tail(cfg.Log.(*lockedBuf).String(), 3000))
		}
	}
}

// S16: strays, root files, a symlink named like an entry and empty bucket
// directories are never touched, at the hard floor with a one-byte budget.
func TestS16StraysNeverTouched(t *testing.T) {
	dir := tempDir(t)
	for _, n := range []string{"README", "testexpire.txt", "log.txt", ".DS_Store"} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o666)
	}
	os.MkdirAll(filepath.Join(dir, "fuzz", "ab"), 0o777)
	os.WriteFile(filepath.Join(dir, "fuzz", "ab", "ab"+strings.Repeat("0", 62)+"-d"), []byte("x"), 0o666)
	for _, d := range []string{"zz", "0G", "ab.bak", "00"} {
		os.Mkdir(filepath.Join(dir, d), 0o777)
	}
	ab := filepath.Join(dir, "ab")
	os.Mkdir(ab, 0o777)
	h := "ab" + strings.Repeat("1", 62)
	for _, n := range []string{".DS_Store", h + "-d.tmp", h + "-a.123", h[:63] + "-a", h + "1-a", "AB" + h[2:] + "-a", "foo-a", "cd" + h[2:] + "-a"} {
		os.WriteFile(filepath.Join(ab, n), make([]byte, 5000), 0o666)
	}
	victim := filepath.Join(tempDir(t), "victim")
	os.WriteFile(victim, make([]byte, 1<<20), 0o666)
	os.Symlink(victim, filepath.Join(ab, h+"-d"))
	var managed []entryIDs
	for i := 0; i < 50; i++ {
		managed = append(managed, putEntry(t, dir, 4000, 30*24*time.Hour))
	}
	for _, p := range []string{victim} {
		setAge(t, p, 30*24*time.Hour)
	}
	before := snapshot(t, dir)

	cfg := fastConfig(t, dir, 5_000_000_000)
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	waitFor(t, time.Minute, "managed entries evicted", func() bool {
		for _, e := range managed {
			if a, d := e.paths(dir); exists(a) || exists(d) {
				return false
			}
		}
		return true
	})
	time.Sleep(10 * cfg.Tick)
	stop()
	after := snapshot(t, dir)
	isManaged := map[string]bool{}
	for _, e := range managed {
		a, d := e.paths(dir)
		ra, _ := filepath.Rel(dir, a)
		rd, _ := filepath.Rel(dir, d)
		isManaged[ra], isManaged[rd] = true, true
	}
	for k, v := range before {
		if isManaged[k] || k == "." {
			continue
		}
		if w, ok := after[k]; !ok {
			t.Errorf("%s removed", k)
		} else if w != v && len(k) != 2 {
			t.Errorf("%s changed", k)
		}
	}
	if st, err := os.Stat(victim); err != nil || st.Size() != 1<<20 {
		t.Errorf("symlink target harmed: %v", err)
	}
	if !exists(filepath.Join(dir, "00")) {
		t.Error("an empty bucket directory was removed")
	}
	st := readState(t, cfg.StateDir)
	if st.Extra.UnmanagedFiles != 9 {
		t.Errorf("unmanaged files in buckets %d, want 9", st.Extra.UnmanagedFiles)
	}
	// At the root: README, testexpire.txt, log.txt, .DS_Store, trim.txt and the
	// fuzz corpus file, the fuzz/ part apart; status explains the gap to du.
	if st.Extra.RootUnmanagedFiles != 6 || st.Extra.FuzzBytes == 0 || st.Extra.RootUnmanagedBytes < st.Extra.FuzzBytes {
		t.Errorf("root unmanaged: %d files, %d bytes, fuzz %d", st.Extra.RootUnmanagedFiles, st.Extra.RootUnmanagedBytes, st.Extra.FuzzBytes)
	}
	du := false
	for _, r := range st.Extra.Reasons {
		du = du || strings.Contains(r, "du shows about") && strings.Contains(r, "fuzz/")
	}
	if !du {
		t.Errorf("no reason explains the gap to du: %q", st.Extra.Reasons)
	}
}

// countingFS counts trim.txt writes.
type countingFS struct {
	cachefs.FS
	trims atomic.Int32
}

func (c *countingFS) WriteTrim(b []byte) error { c.trims.Add(1); return c.FS.WriteTrim(b) }

// S15c/f: trim.txt is integer seconds, never ahead of now; when it can't be
// written, status says Go's trim is not suppressed and there is no retry
// loop.
func TestTrimTxt(t *testing.T) {
	dir := tempDir(t)
	putEntry(t, dir, 100, 0)
	cfg := fastConfig(t, dir, 50_000_000_000)
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	waitFor(t, time.Minute, "trim.txt", func() bool { return exists(filepath.Join(dir, "trim.txt")) })
	stop()
	data, _ := os.ReadFile(filepath.Join(dir, "trim.txt"))
	v, err := strconv.ParseInt(string(data), 10, 64)
	if err != nil || v > time.Now().Unix() || v < time.Now().Unix()-10 {
		t.Errorf("trim.txt %q, now %d", data, time.Now().Unix())
	}

	dir2 := tempDir(t)
	putEntry(t, dir2, 100, 0)
	os.Mkdir(filepath.Join(dir2, "trim.txt"), 0o777)
	cfg2 := fastConfig(t, dir2, 50_000_000_000)
	cfs := &countingFS{FS: cachefs.NewOS(dir2)}
	cfg2.FS = cfs
	setMode(t, cfg2.StateDir, "owner")
	stop2 := startRun(t, cfg2)
	waitFor(t, time.Minute, "status about trim", func() bool {
		for _, r := range readState(t, cfg2.StateDir).Extra.Reasons {
			if strings.Contains(r, "Go trim not suppressed") {
				return true
			}
		}
		return false
	})
	time.Sleep(time.Second)
	stop2()
	if n := cfs.trims.Load(); n > 2 {
		t.Errorf("%d trim.txt attempts in about a second: a retry loop", n)
	}
}

// S4b: the parser corpus under a running owner daemon: no panic, malformed
// -a files go by the normal rules, odd shapes stay.
func TestS4bCorpusUnderDaemon(t *testing.T) {
	dir := tempDir(t)
	good := putEntry(t, dir, 100, 3*time.Hour)
	_, goodOut := good.paths(dir)
	ab := filepath.Join(dir, "ab")
	os.MkdirAll(ab, 0o777)
	write := func(name, body string) string {
		p := filepath.Join(ab, name)
		os.WriteFile(p, []byte(body), 0o666)
		setAge(t, p, 3*time.Hour)
		return p
	}
	hex := func(c string) string { return "ab" + strings.Repeat(c, 62) }
	empty := write(hex("1")+"-a", "")
	v2 := write(hex("2")+"-a", "v2 garbage")
	short := write(hex("3")+"-a", "v1 "+strings.Repeat("a", 60))
	os.Mkdir(filepath.Join(ab, hex("4")+"-a"), 0o777)
	two := filepath.Join(ab, hex("5")+"-d")
	os.Mkdir(two, 0o777)
	os.WriteFile(filepath.Join(two, "x"), nil, 0o666)
	os.WriteFile(filepath.Join(two, "y"), nil, 0o666)
	setAge(t, two, 3*time.Hour)

	cfg := fastConfig(t, dir, 12_000_000_000) // below 15 GB: no start grace
	setMode(t, cfg.StateDir, "owner")
	stop := startRun(t, cfg)
	deadline := time.Now().Add(20 * time.Second)
	// The empty -a frees no bytes, so no budget ever asks for it; it stays.
	for exists(v2) || exists(short) || exists(goodOut) {
		if time.Now().After(deadline) {
			t.Fatalf("not evicted: empty %v v2 %v short %v goodOut %v\n%s", exists(empty), exists(v2), exists(short), exists(goodOut), tail(cfg.Log.(*lockedBuf).String(), 3000))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Errorf("exit %d", code)
	}
	if !exists(filepath.Join(ab, hex("4")+"-a")) || !exists(filepath.Join(two, "x")) || !exists(empty) {
		t.Error("an unmanaged shape was touched")
	}
}

// The loop's thread runs at background priority only while asked to.
func TestThreadPriority(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	p := ThreadPriority{}
	p.Background(true)
	if !threadIsBackground() {
		t.Error("background priority not applied")
	}
	p.Background(false)
	if threadIsBackground() {
		t.Error("background priority not lifted")
	}
}

// D9 and S28: a missing cache dir leaves the daemon up, creating nothing,
// with status "waiting for cache dir"; when go creates it, indexing starts.
func TestMissingCacheDir(t *testing.T) {
	parent := tempDir(t)
	dir := filepath.Join(parent, "go-build")
	cfg := fastConfig(t, dir, 50_000_000_000)
	setMode(t, cfg.StateDir, "owner")
	cfg.FS, cfg.Disk = nil, newDisk(50_000_000_000)
	stop := startRun(t, cfg)
	waitFor(t, time.Minute, "waiting status", func() bool {
		return readState(t, cfg.StateDir).Extra.Phase == "waiting-for-cache-dir"
	})
	time.Sleep(10 * cfg.Tick)
	if exists(dir) {
		t.Fatal("the daemon created the cache dir")
	}
	if r := readState(t, cfg.StateDir).Extra.Reasons; len(r) == 0 || !strings.Contains(r[0], "waiting for cache dir") {
		t.Errorf("reasons %q", r)
	}
	os.Mkdir(dir, 0o777)
	putEntry(t, dir, 100, 0)
	waitFor(t, time.Minute, "indexing after the dir appears", func() bool {
		return readState(t, cfg.StateDir).Extra.Phase == "ready"
	})
	stop()
}

// S29: status works with the daemon down: never ran is valid JSON with a
// marker; a dead daemon is stale with its last numbers.
func TestStatusDaemonDown(t *testing.T) {
	dir := tempDir(t)
	st, err := ReadStatus(dir, time.Now())
	if err != nil || !st.NeverRan {
		t.Fatalf("never ran: %+v %v", st, err)
	}
	size := int64(12345)
	ownerstate.WriteJSON(dir, ownerstate.StateFile, ownerstate.State{Mode: "owner", SizeBytes: &size, HeartbeatAt: time.Now().Add(-10 * time.Minute).Unix()})
	ownerstate.WriteJSON(dir, ownerstate.OwnerFile, ownerstate.Owner{Schema: 1, HeartbeatAt: time.Now().Add(-10 * time.Minute).Unix()})
	st, _ = ReadStatus(dir, time.Now())
	if !st.Stale || st.HeartbeatFresh || st.SizeBytes == nil || *st.SizeBytes != size {
		t.Errorf("dead daemon: %+v", st)
	}
}
