package realhome

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, p, data string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(p), 0o700)
	if err := os.WriteFile(p, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A fake home with the live daemon's files: what a test may leave changed
// (the daemon's own heartbeat writes) and what it may not.
func TestCheck(t *testing.T) {
	home := t.TempDir()
	tmp := "/private/var/folders/xx/T"
	state := filepath.Join(home, ".pod", "gocache")
	trim := filepath.Join(home, "Library", "Caches", "go-build", "trim.txt")
	write(t, filepath.Join(state, "owner.json"), `{"pid":1,"cacheDir":"/Users/u/Library/Caches/go-build"}`)
	write(t, filepath.Join(state, "state.json"), `{"extra":{"trimWrittenAt":100}}`)
	write(t, filepath.Join(state, "mode"), "owner")
	write(t, filepath.Join(state, "bin", "pod-gocache"), "binary")
	write(t, trim, "100")

	cases := []struct {
		name string
		do   func()
		want string // "" for no finding
	}{
		{"heartbeat rewrite", func() {
			write(t, filepath.Join(state, "owner.json"), `{"pid":1,"cacheDir":"/Users/u/Library/Caches/go-build","heartbeatAt":2}`)
		}, ""},
		{"daemon trim rewrite", func() {
			write(t, filepath.Join(state, "state.json"), `{"extra":{"trimWrittenAt":200}}`)
			write(t, trim, "200")
		}, ""},
		{"a test daemon's owner.json", func() {
			write(t, filepath.Join(state, "owner.json"), `{"pid":9,"cacheDir":"`+tmp+`/TestX/gocache"}`)
		}, "owner.json changed"},
		{"trim.txt from someone else", func() { write(t, trim, "300") }, "trim.txt changed"},
		{"mode switched", func() { write(t, filepath.Join(state, "mode"), "observe") }, "mode changed"},
		{"a trace dir", func() { write(t, filepath.Join(state, "trace", "x"), "") }, "trace appeared"},
		{"the default shared-state root", func() {
			write(t, filepath.Join(home, "Library", "Caches", "pod-gocache", "live", "x"), "")
		}, "pod-gocache/live appeared"},
		{"binary removed", func() { os.Remove(filepath.Join(state, "bin", "pod-gocache")) }, "bin/pod-gocache went"},
	}
	for _, c := range cases {
		snap := Take(home)
		time.Sleep(10 * time.Millisecond) // a rewrite within the same tick still moves the ctime
		c.do()
		got := snap.Check(tmp)
		switch {
		case c.want == "" && len(got) > 0:
			t.Errorf("%s: unexpected %v", c.name, got)
		case c.want != "" && (len(got) != 1 || !strings.Contains(got[0], c.want)):
			t.Errorf("%s: got %v, want one finding with %q", c.name, got, c.want)
		}
	}
}
