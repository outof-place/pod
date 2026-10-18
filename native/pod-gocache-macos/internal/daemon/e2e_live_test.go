package daemon

import (
	"bufio"
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

// S9 end to end: go runs through the client while the daemon publishes the
// shared state, pins what clients serve and evicts. POD_GOCACHE_E2E=1 runs
// them.

var (
	clientOnce sync.Once
	clientPath string
	clientErr  error
)

// useClient builds cmd/pod-gocache once per test binary (into TestMain's
// throwaway home) and runs every later go command of e through it.
func (e *e2e) useClient() {
	e.t.Helper()
	clientOnce.Do(func() {
		clientPath = filepath.Join(os.Getenv("HOME"), "client-bin", "pod-gocache")
		cmd := exec.Command(e.goBin, "build", "-o", clientPath, "../../cmd/pod-gocache")
		cmd.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOFLAGS=", "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			clientErr = fmt.Errorf("%v\n%s", err, out)
		}
	})
	if clientErr != nil {
		e.t.Fatalf("building pod-gocache: %v", clientErr)
	}
	e.client = clientPath
}

// waitPublished waits until the daemon publishes every -a file in the cache.
func (e *e2e) waitPublished() {
	e.t.Helper()
	waitFor(e.t, 3*time.Minute, "the daemon to publish every entry", func() bool {
		l := readState(e.t, e.cfg.StateDir).Extra.Live
		return l != nil && l.Reason == "" && l.Entries > 0 && l.Entries == countActionFiles(e.cache)
	})
}

func countActionFiles(dir string) int {
	n := 0
	buckets, _ := os.ReadDir(dir)
	for _, b := range buckets {
		if len(b.Name()) != 2 || !b.IsDir() {
			continue
		}
		names, _ := os.ReadDir(filepath.Join(dir, b.Name()))
		for _, f := range names {
			if strings.HasSuffix(f.Name(), "-a") {
				n++
			}
		}
	}
	return n
}

// fastHits counts the client's gets served from the shared index, and those
// whose -a or -d the daemon evicted later in the run.
func (e *e2e) fastHits() (fast, evictedLater int, sessions map[string]int) {
	e.t.Helper()
	recs, err := trace.ReadDir(e.trace)
	if err != nil {
		e.t.Fatal(err)
	}
	last := map[uint64]int64{}
	for _, ev := range e.evictions() {
		if p, ok := relPrefix(ev.Rel); ok && ev.Wall > last[p] {
			last[p] = ev.Wall
		}
	}
	sessions = map[string]int{}
	for _, r := range recs {
		switch r.Op {
		case trace.OpGetFast:
			fast++
			if last[r.Action] > r.Time || last[r.Output] > r.Time {
				evictedLater++
			}
		case trace.OpLive:
			sessions[livestate.Reason(r.Live().Index).String()]++
		}
	}
	return fast, evictedLater, sessions
}

// relPrefix is the trace's 8-byte ID prefix of an entry path xx/<hex>-a|d[/inner].
func relPrefix(rel string) (uint64, bool) {
	_, name, ok := strings.Cut(rel, "/")
	if !ok || len(name) < 16 {
		return 0, false
	}
	p, err := strconv.ParseUint(name[:16], 16, 64)
	return p, err == nil
}

// S2 through the client (S9's real e2e): the same ten loops for twenty
// rounds, every go command through the client on the fast path while the
// daemon publishes, pins and evicts at 6 GB free. No go command fails, and no
// export file goes before its go list exits (after that nothing pins it: at
// 20 rounds the built-in cache loses about 3,000 export files to the
// emergency tier's window too). Not vacuous: at least 1000 fast-path hits on
// entries the daemon evicted later in the run.
func TestE2ES9RevivalRaceClient(t *testing.T) {
	e := newE2E(t, 6_000_000_000)
	e.useClient()
	// The loops start as soon as the daemon is ready, as in S2: it publishes on
	// its next tick, and waiting longer would let it evict every aged entry first.
	aged := e.revivalSetup()
	r := e.revivalRace(e2eRounds(20))
	st := readState(t, e.cfg.StateDir).Extra.Live
	e.stop()
	e.revivalChecks(aged, r, false)
	fast, later, sessions := e.fastHits()
	t.Logf("fast-path hits %d, %d of them on entries evicted later; sessions by index reason %v; status %+v", fast, later, sessions, st)
	if later < 1000 {
		t.Errorf("only %d fast-path hits on entries evicted later in the run; want at least 1000", later)
	}
	// What the go processes' clients reported reaches state.json after they exit.
	if st == nil || st.Sessions.FastHits == 0 || st.Sessions.Puts == 0 || st.Sessions.IndexReasons["ok"] == 0 {
		t.Errorf("state.json does not sum the ended sessions: %+v", st)
	}
}

// S6: shared files truncated, replaced or renamed over, the live directory
// deleted, and the daemon restarted, while eight loops of warm builds and
// tests run through the client. Every go command succeeds; none sees a
// fault. After the last step (the directory deleted) the daemon recreates
// the files: most later sessions use the index again and fast hits resume.
func TestE2ES9TamperedSharedFiles(t *testing.T) {
	e := newE2E(t, 60_000_000_000)
	e.useClient()
	fixture220(e)
	e.run("build", "./...")
	e.run("test", "./...")
	e.startDaemon(nil)
	e.waitPublished()
	id, ok := livestate.StatCache(e.cache)
	if !ok {
		t.Fatal("cache directory")
	}
	dir := livestate.Dir(e.live, id)
	idx, cli := filepath.Join(dir, livestate.IndexName), filepath.Join(dir, livestate.ClientsName)
	size := func(p string) int64 {
		fi, err := os.Stat(p)
		if err != nil {
			return 0
		}
		return fi.Size()
	}
	replace := func(p string, n int64, rename bool) {
		tmp := p + ".garbage"
		b := make([]byte, n)
		for i := range b {
			b[i] = byte(rand.IntN(256))
		}
		os.WriteFile(tmp, b, 0o600)
		if !rename {
			os.Remove(p)
		}
		os.Rename(tmp, p)
	}
	steps := []struct {
		name string
		do   func()
	}{
		{"index truncated to 0", func() { os.Truncate(idx, 0) }},
		{"index cut in half", func() { os.Truncate(idx, size(idx)/2) }},
		{"index cut to its header", func() { os.Truncate(idx, 16384) }},
		{"index unlinked and recreated smaller", func() { replace(idx, 20000, false) }},
		{"index renamed over", func() { replace(idx, 1<<20, true) }},
		{"clients truncated to 0", func() { os.Truncate(cli, 0) }},
		{"clients cut in half", func() { os.Truncate(cli, size(cli)/2) }},
		{"daemon restarted", func() {
			e.stop()
			e.startDaemon(nil)
		}},
		{"clients unlinked and recreated smaller", func() { replace(cli, 20000, false) }},
		{"live directory deleted", func() { os.RemoveAll(dir) }},
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failures []string
	done := make(chan struct{})
	for loop := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for round := 0; ; round++ {
				select {
				case <-done:
					return
				default:
				}
				args := []string{"build", "./..."}
				if (loop+round)%2 == 1 {
					args = []string{"test", "./..."}
				}
				out, err := e.cmd(e.goBin, args...).CombinedOutput()
				f := failed(string(out))
				for _, s := range []string{"GOCACHEPROG", "unexpected fault address", "panic:"} {
					if strings.Contains(string(out), s) {
						f = s
					}
				}
				if err != nil || f != "" {
					mu.Lock()
					failures = append(failures, fmt.Sprintf("go %s: %v %s\n%s", strings.Join(args, " "), err, f, out[:min(len(out), 600)]))
					mu.Unlock()
				}
			}
		}()
	}
	var last int64
	for range 2 {
		for _, s := range steps {
			time.Sleep(2 * time.Second)
			t.Logf("%s: %s", time.Now().Format("15:04:05.000"), s.name)
			s.do()
			last = time.Now().UnixNano()
		}
	}
	time.Sleep(15 * time.Second)
	close(done)
	wg.Wait()
	e.stop()
	for _, f := range failures[:min(5, len(failures))] {
		t.Error(f)
	}
	fast, _, sessions := e.fastHits()
	t.Logf("%d go failures; fast-path hits %d; sessions by index reason %v", len(failures), fast, sessions)
	if fast == 0 {
		t.Error("no get came from the shared index: the tampering met no live mapping")
	}
	// Sessions that ended a few seconds after the last step started after the
	// daemon's repair (one tick) or ran through it.
	after := last + int64(5*time.Second)
	recs, err := trace.ReadDir(e.trace)
	if err != nil {
		t.Fatal(err)
	}
	used, total, fastAfter := 0, 0, 0
	for _, r := range recs {
		switch {
		case r.Time < after:
		case r.Op == trace.OpLive:
			total++
			if livestate.Reason(r.Live().Index) == livestate.ReasonOK {
				used++
			}
		case r.Op == trace.OpGetFast:
			fastAfter++
		}
	}
	t.Logf("after the last step: %d of %d sessions used the index, %d fast hits", used, total, fastAfter)
	if total == 0 || used*2 <= total || fastAfter == 0 {
		t.Errorf("the shared state did not come back after the live directory was deleted: %d of %d sessions ok, %d fast hits", used, total, fastAfter)
	}
}

// S5: the daemon stopped (SIGSTOP) at a random moment of its work, three
// times. go never waits for it: 50 go list runs and a warm go test through
// the client succeed within the time S1 takes, and the client's
// capabilities line comes as fast as with the shared state off.
func TestE2ES9StoppedDaemon(t *testing.T) {
	e := newE2E(t, 60_000_000_000)
	e.useClient()
	fixture220(e)
	e.run("build", "./...")
	e.run("test", "./...")
	state := tempDir(t)
	timed := func(env []string, args ...string) time.Duration {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		c := exec.CommandContext(ctx, e.goBin, args...)
		c.Dir, c.Env = e.mod, append(e.env(), env...)
		start := time.Now()
		out, err := c.CombinedOutput()
		if err != nil || failed(string(out)) != "" {
			t.Errorf("go %s: %v\n%s", strings.Join(args, " "), err, out[:min(len(out), 400)])
		}
		return time.Since(start)
	}
	hello := func(env []string) time.Duration {
		c := exec.Command(e.client, "prog")
		c.Env = append(e.env(), env...)
		stdin, _ := c.StdinPipe()
		out, _ := c.StdoutPipe()
		start := time.Now()
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		bufio.NewReader(out).ReadString('\n')
		d := time.Since(start)
		stdin.Close()
		c.Wait()
		return d
	}
	median := func(d []time.Duration) time.Duration {
		slices.Sort(d)
		return d[len(d)/2]
	}
	var offList, offHello []time.Duration
	for range 10 {
		offList = append(offList, timed([]string{"POD_GOCACHE_LIVE=off"}, "list", "-json", "./..."))
		offHello = append(offHello, hello([]string{"POD_GOCACHE_LIVE=off"}))
	}
	var stoppedList, stoppedHello []time.Duration
	var testTimes []time.Duration
	for round := range 3 {
		// Owner (only the owner publishes), with a window no fixture entry
		// leaves during the test.
		setMode(t, state, "owner")
		p := spawnHelper(t, helperCfg{CacheDir: e.cache, StateDir: state, LiveRoot: e.live, Free: 60_000_000_000, Window: 6 * time.Hour}, nil)
		if round > 0 {
			waitFor(t, 3*time.Minute, "the helper to publish", func() bool {
				l := readState(t, state).Extra.Live
				return l != nil && l.Entries > 0 && readState(t, state).Extra.PID == p.cmd.Process.Pid
			})
		}
		time.Sleep(time.Duration(rand.IntN(300)) * time.Millisecond)
		syscall.Kill(p.cmd.Process.Pid, syscall.SIGSTOP)
		for range 50 / 3 {
			stoppedList = append(stoppedList, timed(nil, "list", "-json", "./..."))
			stoppedHello = append(stoppedHello, hello(nil))
		}
		testTimes = append(testTimes, timed(nil, "test", "./..."))
		syscall.Kill(p.cmd.Process.Pid, syscall.SIGCONT)
		p.term(t)
	}
	_, _, sessions := e.fastHits()
	t.Logf("go list median: %s with the shared state off, %s with the daemon stopped; capabilities median %s off, %s stopped (max %s); warm go test %v; sessions by index reason %v",
		median(offList), median(stoppedList), median(offHello), median(stoppedHello), slices.Max(stoppedHello), testTimes, sessions)
	if median(stoppedHello) > median(offHello)+5*time.Millisecond {
		t.Errorf("capabilities line %s with the daemon stopped against %s with the shared state off", median(stoppedHello), median(offHello))
	}
	if median(stoppedList) > median(offList)*3/2+time.Second {
		t.Errorf("go list %s with the daemon stopped against %s with the shared state off", median(stoppedList), median(offList))
	}
}
