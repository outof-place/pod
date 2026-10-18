package realgo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

func atime(t *testing.T, path string) syscall.Timespec {
	t.Helper()
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		t.Fatal(err)
	}
	return st.Atimespec
}

// fifoLive puts FIFOs where the shared files for gocache would be.
func fifoLive(t *testing.T, liveRoot, gocache string) []string {
	t.Helper()
	id, ok := livestate.StatCache(gocache)
	if !ok {
		t.Fatal("cache directory")
	}
	dir := livestate.Dir(liveRoot, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var fifos []string
	for _, name := range []string{livestate.IndexName, livestate.ClientsName} {
		p := filepath.Join(dir, name)
		if err := syscall.Mkfifo(p, 0o600); err != nil {
			t.Fatal(err)
		}
		fifos = append(fifos, p)
	}
	return fifos
}

func sessionReasons(t *testing.T, dir string) map[string]int {
	t.Helper()
	_, _, reasons := liveSessions(t, dir)
	out := map[string]int{}
	for r, n := range reasons {
		out[livestate.Reason(r).String()] += n
	}
	return out
}

// S23: with the kill switch the client never opens the shared state (FIFOs
// there keep their atime, nothing blocks) and writes no trace; without it,
// FIFOs are refused without blocking and the session says why.
func TestKillSwitchAndFIFOs(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	home := canonical(t, t.TempDir())
	ce.extra = append(ce.extra, "HOME="+home)
	fifos := fifoLive(t, ce.live, ce.gocache)
	before := []syscall.Timespec{atime(t, fifos[0]), atime(t, fifos[1])}
	os.MkdirAll(filepath.Join(home, ".pod", "gocache"), 0o700)
	os.WriteFile(filepath.Join(home, ".pod", "gocache", "disabled"), nil, 0o600)
	if r := runGo(t, ws, ce, "build", "./..."); r.code != 0 {
		t.Fatalf("build with the kill switch: %s", r.stderr)
	}
	if recs, _ := trace.ReadDir(ce.trace); len(recs) != 0 {
		t.Errorf("the kill switch left %d trace records", len(recs))
	}
	os.Remove(filepath.Join(home, ".pod", "gocache", "disabled"))
	if r := runGo(t, ws, ce, "test", "./greet", "./calc"); r.code != 0 {
		t.Fatalf("test with FIFOs as shared files: %s", r.stderr)
	}
	for i, f := range fifos {
		if atime(t, f) != before[i] {
			t.Errorf("%s was read", f)
		}
	}
	reasons := sessionReasons(t, ce.trace)
	if reasons["invalid"] == 0 || reasons["ok"] != 0 {
		t.Errorf("sessions by index reason %v, want every one invalid", reasons)
	}
}

// S8: a client for another cache never touches the shared state published
// for cache A; spellings of A itself (trailing slash, a symlink) do use it,
// and their DiskPaths keep the spelling go passed.
func TestOtherCacheAndSpellings(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	a := newCache(t, true)
	populate(t, ws, a)
	pub := startPublisher(t, a)
	pub.sync(t, a)
	mtimes := snapshotMtimes(t, a.gocache)

	b := newCache(t, true)
	b.live = a.live
	r := runGo(t, ws, b, "build", "-x", "./...")
	if r.code != 0 || !compileRE.MatchString(r.stderr) {
		t.Fatalf("cache B build: exit %d, compiled %v", r.code, compileRE.MatchString(r.stderr))
	}
	if n := traceCounts(t, b.trace)[trace.OpGetFast]; n != 0 {
		t.Errorf("cache B served %d gets from A's index", n)
	}
	if reasons := sessionReasons(t, b.trace); reasons["missing"] == 0 || reasons["ok"] != 0 {
		t.Errorf("cache B sessions by index reason %v, want missing", reasons)
	}
	r = runGo(t, ws, b, "list", "-export", "-f", "{{.Export}}", "./...")
	for _, p := range strings.Fields(r.stdout) {
		if !strings.HasPrefix(p, b.gocache+"/") {
			t.Errorf("cache B export path %s outside B", p)
		}
	}
	if changed := diffMtimes(mtimes, snapshotMtimes(t, a.gocache)); len(changed) > 0 {
		t.Errorf("cache B's builds touched %d of A's entries, first %s", len(changed), changed[0])
	}

	link := filepath.Join(canonical(t, t.TempDir()), "a-link")
	if err := os.Symlink(a.gocache, link); err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{a.gocache + "/", link} {
		s := a
		s.gocache, s.trace = spelling, filepath.Join(canonical(t, t.TempDir()), "trace")
		r := runGo(t, ws, s, "list", "-export", "-f", "{{.Export}}", "./...")
		if r.code != 0 {
			t.Fatalf("%s: %s", spelling, r.stderr)
		}
		want := strings.TrimSuffix(spelling, "/") + "/"
		for _, p := range strings.Fields(r.stdout) {
			if !strings.HasPrefix(p, want) {
				t.Errorf("GOCACHE=%s: export path %s does not keep the spelling", spelling, p)
			}
		}
		if n := traceCounts(t, s.trace)[trace.OpGetFast]; n == 0 {
			t.Errorf("GOCACHE=%s served nothing from the shared index", spelling)
		}
	}
}

func snapshotMtimes(t *testing.T, dir string) map[string]int64 {
	t.Helper()
	m := map[string]int64{}
	filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			m[p] = fi.ModTime().UnixNano()
		}
		return nil
	})
	return m
}

func diffMtimes(a, b map[string]int64) []string {
	var out []string
	for p, at := range a {
		if b[p] != at && !strings.HasSuffix(p, "trim.txt") {
			out = append(out, p)
		}
	}
	return out
}

// S15: go through the client under sandbox-exec profiles. Builds match the
// built-in cache's, nothing hangs, and a profile that denies the shared
// state leaves the session without it, as S1 ran.
func TestSandboxedClient(t *testing.T) {
	requireRealGo(t)
	if _, err := exec.LookPath("sandbox-exec"); err != nil {
		t.Skip("no sandbox-exec")
	}
	ws := newWorkspace(t)
	ref := newCache(t, false)
	populate(t, ws, ref)
	want := runGo(t, ws, ref, "test", "./greet", "./calc")
	if want.code != 0 {
		t.Fatalf("built-in: %s", want.stderr)
	}
	profiles := []struct {
		name, rules string
		reason      string // the index reason every session must report
	}{
		// The index stays readable; the clients file cannot be opened for writing.
		{"writes only to the cache and TMPDIR", `(deny file-write* (require-not (require-any (subpath "$CACHE") (subpath "$TMP") (subpath "$TRACE") (subpath "/dev") (subpath "$OUT"))))`, "ok"},
		{"no reads of the shared state", `(deny file-read* (subpath "$LIVE"))`, "denied"},
		{"no network or POSIX shared memory", `(deny network*) (deny ipc-posix-shm*)`, "ok"},
	}
	for _, p := range profiles {
		t.Run(p.name, func(t *testing.T) {
			ce := newCache(t, true)
			populate(t, ws, ce)
			pub := startPublisher(t, ce)
			pub.sync(t, ce)
			os.RemoveAll(ce.trace)
			tmp := filepath.Join(filepath.Dir(ce.gocache), "tmp")
			os.MkdirAll(tmp, 0o700)
			ce.extra = append(ce.extra, "TMPDIR="+tmp, "GOTELEMETRY=off")
			rules := strings.NewReplacer("$CACHE", ce.gocache, "$TMP", tmp, "$TRACE", ce.trace, "$LIVE", ce.live, "$OUT", ws.out).Replace(p.rules)
			cmd := exec.Command("sandbox-exec", "-p", "(version 1) (allow default) "+rules, "go", "test", "./greet", "./calc")
			cmd.Dir, cmd.Env = ws.src, goEnv(ce)
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("sandboxed go test: %v\n%s", err, out)
			}
			if normalize(string(out), ws, ce) != normalize(want.stdout, ws, ref) {
				t.Errorf("stdout differs from the built-in cache:\n%s\nwant\n%s", out, want.stdout)
			}
			reasons := sessionReasons(t, ce.trace)
			if len(reasons) != 1 || reasons[p.reason] == 0 {
				t.Errorf("sessions by index reason %v, want %s", reasons, p.reason)
			}
		})
	}
}
