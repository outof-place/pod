package ownerstate

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// S26: only a regular file whose trimmed content is "owner" asks for owner
// mode; everything else is observe with a reason, read without blocking.
func TestReadModeCorpus(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ModeFile)
	big := make([]byte, 10<<20)
	rand.Read(big)
	cases := []struct {
		name  string
		setup func()
		mode  string
		valid bool
	}{
		{"missing", func() {}, ModeObserve, true},
		{"empty", func() { os.WriteFile(path, nil, 0o600) }, ModeObserve, false},
		{"owner-newline", func() { os.WriteFile(path, []byte("owner\n"), 0o600) }, ModeOwner, true},
		{"owner-spaces-crlf", func() { os.WriteFile(path, []byte(" owner \r\n"), 0o600) }, ModeOwner, true},
		{"observe", func() { os.WriteFile(path, []byte("observe\n"), 0o600) }, ModeObserve, true},
		{"uppercase", func() { os.WriteFile(path, []byte("OWNER"), 0o600) }, ModeObserve, false},
		{"typo", func() { os.WriteFile(path, []byte("ownr"), 0o600) }, ModeObserve, false},
		{"10MB-random", func() { os.WriteFile(path, big, 0o600) }, ModeObserve, false},
		{"directory", func() { os.Mkdir(path, 0o700) }, ModeObserve, false},
		{"dangling-symlink", func() { os.Symlink(filepath.Join(dir, "nowhere"), path) }, ModeObserve, false},
		{"symlink-to-owner", func() {
			os.WriteFile(filepath.Join(dir, "real"), []byte("owner"), 0o600)
			os.Symlink(filepath.Join(dir, "real"), path)
		}, ModeObserve, false},
		{"chmod-000", func() { os.WriteFile(path, []byte("owner"), 0o000) }, ModeObserve, false},
		{"fifo", func() { syscall.Mkfifo(path, 0o600) }, ModeObserve, false},
	}
	for _, c := range cases {
		os.RemoveAll(path)
		c.setup()
		done := make(chan struct{})
		var mode, reason string
		var valid bool
		go func() { mode, valid, reason = ReadMode(dir); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: ReadMode blocked", c.name)
		}
		if os.Getuid() == 0 && c.name == "chmod-000" {
			continue
		}
		if mode != c.mode || valid != c.valid || reason == "" {
			t.Errorf("%s: %s valid=%v (%q), want %s valid=%v", c.name, mode, valid, reason, c.mode, c.valid)
		}
	}
}

// Readers never see a torn owner.json or state.json.
func TestWriteAtomicNoTornReads(t *testing.T) {
	dir := t.TempDir()
	WriteJSON(dir, OwnerFile, Owner{Schema: 1})
	var wg sync.WaitGroup
	stop := make(chan struct{})
	var torn []string
	var mu sync.Mutex
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				data, err := os.ReadFile(filepath.Join(dir, OwnerFile))
				var o Owner
				if err != nil || json.Unmarshal(data, &o) != nil || o.Schema != 1 {
					mu.Lock()
					torn = append(torn, string(data))
					mu.Unlock()
				}
			}
		}()
	}
	for i := 0; i < 300; i++ {
		pad := strings.Repeat("x", i)
		if err := WriteJSON(dir, OwnerFile, Owner{Schema: 1, Version: pad, HeartbeatAt: int64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	if len(torn) > 0 {
		t.Fatalf("%d torn reads, first %q", len(torn), torn[0])
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Errorf("temp files left: %v", ents)
	}
}

// D5's time rule: fresh within 120 s either way.
func TestFresh(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	for _, c := range []struct {
		hb   int64
		want bool
	}{{now.Unix(), true}, {now.Unix() - 120, true}, {now.Unix() - 121, false}, {now.Unix() + 120, true}, {now.Unix() + 121, false}, {0, false}} {
		if got := Fresh(c.hb, now); got != c.want {
			t.Errorf("Fresh(now%+d) = %v", c.hb-now.Unix(), got)
		}
	}
}

// The crash-loop record: unclean starts within the window count; a clean
// exit clears its own; a reset forgets all.
func TestStarts(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(2_000_000_000, 0)
	RecordStart(dir, now.Add(-11*time.Minute), 100, 10*time.Minute)
	for i, pid := range []int{101, 102, 103} {
		n, err := RecordStart(dir, now.Add(time.Duration(i)*time.Minute), pid, 10*time.Minute)
		if err != nil || n != i+1 {
			t.Fatalf("start %d: count %d err %v", i, n, err)
		}
	}
	ClearStart(dir, 102)
	if n := recentStarts(dir, now.Add(3*time.Minute), 10*time.Minute); n != 2 {
		t.Errorf("after a clean exit: %d recent starts, want 2", n)
	}
	ResetStarts(dir)
	if n := recentStarts(dir, now, 10*time.Minute); n != 0 {
		t.Errorf("after reset: %d", n)
	}
}
