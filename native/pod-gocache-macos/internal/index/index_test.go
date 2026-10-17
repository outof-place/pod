package index

import (
	"crypto/sha256"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
)

type fixture struct {
	t   *testing.T
	dir string
	rng *rand.Rand
}

func newFixture(t *testing.T) *fixture {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, dir: dir, rng: rand.New(rand.NewSource(1))}
}

func (f *fixture) id() ID {
	var id ID
	f.rng.Read(id[:])
	return id
}

func (f *fixture) path(id ID, kind byte) string {
	p := filepath.Join(f.dir, cachefs.EntryRel(id, kind))
	os.MkdirAll(filepath.Dir(p), 0o777)
	return p
}

// action writes an -a the way cache.go's putIndexEntry does.
func (f *fixture) action(id, out ID, size int64) string {
	p := f.path(id, cachefs.KindAction)
	body := fmt.Sprintf("v1 %x %x %20d %20d\n", id, out, size, time.Now().UnixNano())
	if err := os.WriteFile(p, []byte(body), 0o666); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fixture) raw(id ID, kind byte, body string) string {
	p := f.path(id, kind)
	if err := os.WriteFile(p, []byte(body), 0o666); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fixture) output(out ID, size int) string {
	p := f.path(out, cachefs.KindOutput)
	if err := os.WriteFile(p, make([]byte, size), 0o666); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func age(t *testing.T, p string, d time.Duration) {
	when := time.Now().Add(-d)
	if err := os.Chtimes(p, when, when); err != nil {
		t.Fatal(err)
	}
}

// always never stops a step early.
func always() bool { return true }

func full(t *testing.T, dir string) *Index {
	x := New(cachefs.NewOS(dir))
	if !x.IndexStep(always) {
		t.Fatal("index not complete")
	}
	return x
}

// duBytes is du's allocated size of dir, an independent measure.
func duBytes(t *testing.T, dir string) int64 {
	out, err := exec.Command("du", "-sk", dir).Output()
	if err != nil {
		t.Fatal(err)
	}
	kb, err := strconv.ParseInt(strings.Fields(string(out))[0], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return kb * 1024
}

// S18a: 5000 -a share the empty output, 3 share one 10 MB output. Shared
// outputs count once, and the size matches du within 2 %.
func TestSharedOutputsAndSize(t *testing.T) {
	f := newFixture(t)
	empty := ID(sha256.Sum256(nil))
	f.output(empty, 0)
	big := f.id()
	f.output(big, 10_000_000)
	for i := 0; i < 5000; i++ {
		f.action(f.id(), empty, 0)
	}
	for i := 0; i < 3; i++ {
		f.action(f.id(), big, 10_000_000)
	}
	for i := 0; i < 50; i++ {
		o := f.id()
		f.output(o, 100_000+i)
		f.action(f.id(), o, int64(100_000+i))
	}
	x := full(t, f.dir)
	if x.Refs(empty) != 5000 || x.Refs(big) != 3 {
		t.Errorf("refs empty %d big %d", x.Refs(empty), x.Refs(big))
	}
	du := duBytes(t, f.dir)
	if diff := float64(x.Size()-du) / float64(du); diff > 0.02 || diff < -0.02 {
		t.Errorf("index size %d, du %d (%.1f%%)", x.Size(), du, diff*100)
	}
	if x.Actions() != 5053 || x.Outputs() != 52 {
		t.Errorf("actions %d outputs %d", x.Actions(), x.Outputs())
	}
	for _, u := range x.Units(nil, time.Now().UnixNano(), time.Now().Add(time.Hour).UnixNano()) {
		if u.Orphan {
			t.Fatalf("orphan %x with references", u.ID)
		}
	}
}

// S18b: Put skips chtimes on an identical output, so a new -a can point at
// an old -d; after the next poll the output is referenced and as recent as
// that -a.
func TestNewActionProtectsOldOutput(t *testing.T) {
	f := newFixture(t)
	out := f.id()
	op := f.output(out, 50_000)
	age(t, op, 3*time.Hour)
	x := full(t, f.dir)
	if x.Refs(out) != 0 {
		t.Fatal("referenced before any -a")
	}
	time.Sleep(10 * time.Millisecond) // a distinct bucket mtime
	a := f.id()
	f.action(a, out, 50_000)
	x.Poll(always)
	x.RelistDirty(always)
	if x.Refs(out) != 1 {
		t.Fatalf("refs after a new -a: %d", x.Refs(out))
	}
	for _, u := range x.Units(nil, time.Now().UnixNano(), time.Now().Add(time.Hour).UnixNano()) {
		if u.ID == a && time.Since(time.Unix(0, u.Recency)) > time.Minute {
			t.Errorf("unit recency %s ago; the new -a makes it recent", time.Since(time.Unix(0, u.Recency)))
		}
		if u.Orphan && u.ID == out {
			t.Error("output still an orphan")
		}
	}
}

// S18c: an -a rewritten in place (same size, new mtime) is parsed again.
func TestActionRewrittenInPlace(t *testing.T) {
	f := newFixture(t)
	o1, o2 := f.id(), f.id()
	f.output(o1, 1000)
	f.output(o2, 1000)
	a := f.id()
	p := f.action(a, o1, 1000)
	age(t, p, time.Hour)
	x := full(t, f.dir)
	if x.Refs(o1) != 1 {
		t.Fatal("first reference missing")
	}
	f.action(a, o2, 1000)
	x.RestatStep(256, always)
	if x.Refs(o1) != 0 || x.Refs(o2) != 1 {
		t.Errorf("after rewrite: refs o1 %d o2 %d", x.Refs(o1), x.Refs(o2))
	}
}

// S18d and S4b: malformed entries never break the index. Unparseable -a
// files are evictable on their own; lenient parses keep protecting outputs;
// odd shapes are unmanaged and never touched.
func TestParserCorpus(t *testing.T) {
	f := newFixture(t)
	out := f.id()
	f.output(out, 5000)
	good := fmt.Sprintf("v1 %x %x %20d %20d\n", f.id(), out, 5000, time.Now().UnixNano())
	bad := map[string]string{
		"empty":     "",
		"v2":        "v2" + good[2:],
		"nonhex":    good[:68] + "zz" + good[70:],
		"short-131": good[:131],
	}
	lenient := map[string]string{
		"174": good[:174],
		"176": good + "x",
		"neg": strings.Replace(good, fmt.Sprintf("%20d", 5000), fmt.Sprintf("%20d", -1), 1),
		"ovf": good[:154] + "99999999999999999999\n",
	}
	ids := map[string]ID{}
	for name, body := range bad {
		ids[name] = f.id()
		f.raw(ids[name], cachefs.KindAction, body)
	}
	for name, body := range lenient {
		ids[name] = f.id()
		f.raw(ids[name], cachefs.KindAction, body)
	}
	zero := f.id()
	f.output(zero, 0)
	for i := 0; i < 1000; i++ {
		f.action(f.id(), zero, 0)
	}
	emptyDir, twoDir, dirA, fifoA := f.id(), f.id(), f.id(), f.id()
	os.Mkdir(f.path(emptyDir, cachefs.KindOutput), 0o777)
	td := f.path(twoDir, cachefs.KindOutput)
	os.Mkdir(td, 0o777)
	os.WriteFile(filepath.Join(td, "one"), []byte("1"), 0o777)
	os.WriteFile(filepath.Join(td, "two"), []byte("2"), 0o777)
	os.Mkdir(f.path(dirA, cachefs.KindAction), 0o777)
	if err := syscall.Mkfifo(f.path(fifoA, cachefs.KindAction), 0o666); err != nil {
		t.Fatal(err)
	}

	x := full(t, f.dir)
	if int(x.Refs(out)) != len(lenient) {
		t.Errorf("lenient parses reference the output %d times, want %d", x.Refs(out), len(lenient))
	}
	if x.Refs(zero) != 1000 {
		t.Errorf("0-byte output refs %d", x.Refs(zero))
	}
	for name := range bad {
		av, ok := x.Action(ids[name])
		if !ok || av.HasOut {
			t.Errorf("%s -a: indexed %v, references an output %v; want an -a evictable on its own", name, ok, av.HasOut)
		}
	}
	if ov, ok := x.Output(emptyDir); !ok || ov.Shape != ShapeEmptyDir {
		t.Errorf("empty -d dir: %v %+v", ok, ov)
	}
	if _, ok := x.Output(twoDir); ok {
		t.Error("-d dir with two entries is managed")
	}
	if x.UnmanagedCount() != 3 {
		t.Errorf("unmanaged %d, want 3 (two-entry dir, dir -a, FIFO -a)", x.UnmanagedCount())
	}
	for _, u := range x.Units(nil, time.Now().UnixNano(), time.Now().Add(time.Hour).UnixNano()) {
		if b := u.Bytes(true); b < 0 {
			t.Fatalf("negative unit bytes %d", b)
		}
	}
}

// S16: strays in buckets are unmanaged, a symlink named like an entry is not
// followed, and the root's own files are not indexed at all.
func TestStraysAndSymlink(t *testing.T) {
	f := newFixture(t)
	for _, n := range []string{"README", "testexpire.txt", "log.txt", ".DS_Store"} {
		os.WriteFile(filepath.Join(f.dir, n), []byte("x"), 0o666)
	}
	os.MkdirAll(filepath.Join(f.dir, "fuzz", "ab"), 0o777)
	os.WriteFile(filepath.Join(f.dir, "fuzz", "ab", "ab"+strings.Repeat("0", 62)+"-d"), []byte("x"), 0o666)
	for _, d := range []string{"zz", "0G", "ab.bak"} {
		os.Mkdir(filepath.Join(f.dir, d), 0o777)
	}
	ab := filepath.Join(f.dir, "ab")
	os.Mkdir(ab, 0o777)
	h := "ab" + strings.Repeat("1", 62)
	strays := []string{".DS_Store", h + "-d.tmp", h + "-a.123", h[:63] + "-a", h + "1-a", "AB" + h[2:] + "-a", "foo-a", "cd" + h[2:] + "-a"}
	for _, n := range strays {
		os.WriteFile(filepath.Join(ab, n), make([]byte, 5000), 0o666)
	}
	victim := filepath.Join(t.TempDir(), "victim")
	os.WriteFile(victim, make([]byte, 1<<20), 0o666)
	os.Symlink(victim, filepath.Join(ab, h+"-d"))

	x := full(t, f.dir)
	if x.Entries() != 0 || x.Size() != 0 {
		t.Errorf("entries %d size %d, want none managed", x.Entries(), x.Size())
	}
	if x.UnmanagedCount() != len(strays)+1 {
		t.Errorf("unmanaged %d, want %d", x.UnmanagedCount(), len(strays)+1)
	}
	if x.UnmanagedBytes() >= 1<<20 {
		t.Errorf("unmanaged bytes %d include the symlink target", x.UnmanagedBytes())
	}
	// The root walk counts README, testexpire.txt, log.txt, .DS_Store and
	// the fuzz corpus file, and the fuzz/ part apart; buckets are not in it.
	os.WriteFile(filepath.Join(f.dir, "fuzz", "big"), make([]byte, 300_000), 0o666)
	os.Symlink(victim, filepath.Join(f.dir, "link"))
	for !x.WalkRoot(always) {
	}
	bytes, fuzz, files, ok := x.RootUnmanaged()
	if !ok || files != 7 {
		t.Errorf("root walk: %d files (ok %v), want 4 root files, 2 in fuzz/ and the symlink", files, ok)
	}
	if fuzz < 300_000 || fuzz > 400_000 || bytes < fuzz || bytes >= 1<<20 {
		t.Errorf("root walk: %d bytes, fuzz %d; want the 300 KB fuzz file and not the symlink's 1 MB target", bytes, fuzz)
	}
	// A walk cut short resumes and ends with the same totals.
	stops, calls := 0, 0
	for done := false; !done; calls++ {
		done = x.WalkRoot(func() bool { stops++; return false })
	}
	if b2, f2, n2, _ := x.RootUnmanaged(); b2 != bytes || f2 != fuzz || n2 != files || calls < 2 {
		t.Errorf("resumed walk: %d/%d/%d in %d calls, want %d/%d/%d", b2, f2, n2, calls, bytes, fuzz, files)
	}
}

// Finding 8: an entry that turns out gone when the daemon tries to remove it
// was deleted by someone else and counts as vanished; a replaced one does not.
func TestForgetCountsVanished(t *testing.T) {
	f := newFixture(t)
	o1, o2 := f.id(), f.id()
	f.output(o1, 10_000)
	f.output(o2, 10_000)
	x := full(t, f.dir)
	x.Forget(o1, cachefs.KindOutput, true)
	if x.Vanished < 10_000 {
		t.Errorf("gone output: vanished %d", x.Vanished)
	}
	v := x.Vanished
	x.Forget(o2, cachefs.KindOutput, false)
	if x.Vanished != v {
		t.Errorf("replaced output counted as vanished: %d -> %d", v, x.Vanished)
	}
}

// S17: `go clean -cache` removes every bucket; the index drops them without
// counting them as removed by the daemon, and picks up the rebuild.
func TestGoCleanCache(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 200; i++ {
		o := f.id()
		f.output(o, 10_000)
		f.action(f.id(), o, 10_000)
	}
	x := full(t, f.dir)
	before := x.Size()
	ents, _ := os.ReadDir(f.dir)
	for _, e := range ents {
		os.RemoveAll(filepath.Join(f.dir, e.Name()))
	}
	x.Poll(always)
	x.RelistDirty(always)
	if x.Size() != 0 || x.Entries() != 0 || x.Vanished != before {
		t.Errorf("after clean: size %d entries %d vanished %d (was %d)", x.Size(), x.Entries(), x.Vanished, before)
	}
	o := f.id()
	f.output(o, 10_000)
	f.action(f.id(), o, 10_000)
	x.Poll(always)
	x.RelistDirty(always)
	if x.Entries() != 2 || !x.Complete() {
		t.Errorf("after rebuild: entries %d complete %v", x.Entries(), x.Complete())
	}
}

// Amendment 4: client temp files are tracked apart from entries and strays.
func TestTempFiles(t *testing.T) {
	f := newFixture(t)
	ab := filepath.Join(f.dir, "ab")
	os.Mkdir(ab, 0o777)
	os.WriteFile(filepath.Join(ab, ".pgc-tmp.123.4"), make([]byte, 9000), 0o666)
	os.Mkdir(filepath.Join(ab, ".pgc-tmp.123.5"), 0o777)
	x := full(t, f.dir)
	ts := x.Temps(nil)
	if len(ts) != 1 || ts[0].PID != 123 || ts[0].Rel != "ab/.pgc-tmp.123.4" || x.TempBytes() == 0 {
		t.Errorf("temps %+v bytes %d", ts, x.TempBytes())
	}
	if x.UnmanagedCount() != 1 {
		t.Errorf("a directory with a temp name must be unmanaged: %d", x.UnmanagedCount())
	}
}
