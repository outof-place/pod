package realgo

import (
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestClientHitsKeepEntriesAliveAgainstBuiltinTrim: a client serves an entry
// all day; the built-in trim in another go process must still see it as used.
// The hit refreshes the entry's mtime (markUsed); without that Go's own daily
// trim deletes the entries the client keeps reading.
func TestClientHitsKeepEntriesAliveAgainstBuiltinTrim(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	if r := runGo(t, ws, ce, "build", "-x", "./..."); r.code != 0 || !compileRE.MatchString(r.stderr) {
		t.Fatalf("cold build: exit %d\n%s", r.code, tail(r.stderr, 10))
	}

	aged := 6 * 24 * time.Hour
	if n := setCacheMtimes(t, ce.gocache, time.Now().Add(-aged)); n == 0 {
		t.Fatal("no entries to age")
	}

	// The warm build reads every entry it needs through the client.
	if r := runGo(t, ws, ce, "build", "-x", "./..."); r.code != 0 || compileRE.MatchString(r.stderr) {
		t.Fatalf("warm build recompiled (exit %d):\n%s", r.code, joinMatches(r.stderr))
	}

	// A built-in go command trims once a day: make it due, then run one that
	// shares no entries with the fixture except the runtime's.
	trim := filepath.Join(ce.gocache, "trim.txt")
	stale := strconv.FormatInt(time.Now().Add(-25*time.Hour).Unix(), 10)
	if err := os.WriteFile(trim, []byte(stale), 0o666); err != nil {
		t.Fatal(err)
	}
	trigger := newTrimTrigger(t)
	if r := runGo(t, trigger, ce.withProg(false), "build", "-o", "$OUT/trigger", "."); r.code != 0 {
		t.Fatalf("trim trigger build: exit %d\n%s", r.code, r.stderr)
	}
	data, _ := os.ReadFile(trim)
	if at, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64); err != nil || time.Since(time.Unix(at, 0)) > time.Minute {
		t.Fatalf("the built-in trim did not run: trim.txt = %q", data)
	}

	if r := runGo(t, ws, ce, "build", "-x", "./..."); r.code != 0 || compileRE.MatchString(r.stderr) {
		t.Errorf("entries the client used were trimmed: build recompiled (exit %d):\n%s", r.code, joinMatches(r.stderr))
	}
	// No checkStore here: Go's put reuses an aged -d without refreshing it, so
	// its own trim can orphan the trigger's fresh index entries (built-in
	// behavior the client shares).
}

// setCacheMtimes sets the mtime of every -a and -d file and returns how many.
func setCacheMtimes(t *testing.T, gocache string, at time.Time) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(gocache, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if name := d.Name(); strings.HasSuffix(name, "-a") || strings.HasSuffix(name, "-d") {
			n++
			return os.Chtimes(path, at, at)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// newTrimTrigger is a module of its own with a package that imports nothing,
// so building it with the built-in cache touches almost none of the fixture's
// entries.
func newTrimTrigger(t *testing.T) workspace {
	t.Helper()
	root := canonical(t, t.TempDir())
	ws := workspace{src: filepath.Join(root, "src"), out: filepath.Join(root, "out")}
	for _, d := range []string{ws.src, ws.out} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"go.mod":  "module example.com/trimtrigger\n\ngo 1.27\n",
		"main.go": "package main\n\nfunc main() {}\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(ws.src, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, ws.src)
	return ws
}
