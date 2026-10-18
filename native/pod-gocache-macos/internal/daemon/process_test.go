package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// The test binary doubles as a daemon process (POD_GOCACHE_HELPER), so tests
// can SIGKILL a real daemon, run two at once and watch launchd-style
// restarts without touching cmd/.
func TestMain(m *testing.M) {
	switch os.Getenv("POD_GOCACHE_HELPER") {
	case "daemon":
		os.Exit(helperDaemon())
	case "cli":
		os.Exit(DaemonMain(context.Background(), os.Args[1:], os.Stderr, "test"))
	}
	// A default that slips through lands in a throwaway home, never in
	// ~/.pod/gocache or ~/Library/Caches/go-build.
	home, err := os.MkdirTemp("", "pod-gocache-home-")
	if err != nil {
		panic(err)
	}
	os.Setenv("POD_GOCACHE_REAL_HOME", os.Getenv("HOME")) // read-only: the go1.24 toolchain lookup
	os.Setenv("HOME", home)
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}

type helperCfg struct {
	CacheDir, StateDir string
	Free               int64 // fake free disk
	Window             time.Duration
	TickMs, LogMax     int64
	KillAfterInner     bool
	CrashAfter         time.Duration // SIGKILL itself after this
	FullBatch          time.Duration // FullBatchTime; 0 keeps the production 10 s
	EvictPause         time.Duration // each removal takes this long
	MarkOutput         string        // created at the first output removal (inside removePending)
	MarkAction         string        // created at the first -a removal (inside the plan loop)
}

func helperDaemon() int {
	var h helperCfg
	if err := json.Unmarshal([]byte(os.Getenv("POD_GOCACHE_HELPER_CONFIG")), &h); err != nil {
		return 99
	}
	l := evict.Defaults()
	l.Budget = 1
	l.Window, l.HardWindow, l.EmergencyWindow = h.Window, h.Window/2, h.Window/4
	tick := time.Duration(h.TickMs) * time.Millisecond
	cfg := Config{
		CacheDir: h.CacheDir, StateDir: h.StateDir, Version: "test", Limits: l,
		Tick: tick, HeartbeatEvery: 10 * tick, ModeEvery: 5 * tick, IdleRelist: 5 * tick, PressureRelist: 5 * tick,
		PlanEvery: 5 * tick, ProcEvery: 5 * tick, OutputSettle: 5 * tick, LogMax: h.LogMax,
		Disk: newDisk(h.Free), Procs: noProcs{},
	}
	cfg.FullBatchTime = h.FullBatch
	if h.EvictPause > 0 || h.MarkOutput != "" || h.MarkAction != "" {
		cfg.OnEvict = func(e Eviction) {
			mark := h.MarkAction
			if strings.HasSuffix(e.Rel, "-d") || strings.Contains(e.Rel, "-d/") {
				mark = h.MarkOutput
			}
			if mark != "" {
				os.WriteFile(mark, nil, 0o600)
			}
			time.Sleep(h.EvictPause)
		}
	}
	if h.KillAfterInner {
		cfg.AfterInnerUnlink = func() { syscall.Kill(os.Getpid(), syscall.SIGKILL) }
	}
	if h.CrashAfter > 0 {
		go func() {
			time.Sleep(h.CrashAfter)
			syscall.Kill(os.Getpid(), syscall.SIGKILL)
		}()
	}
	return Run(context.Background(), cfg)
}

type proc struct {
	cmd    *exec.Cmd
	stderr *bytes.Buffer
	done   chan int
}

func spawnHelper(t *testing.T, h helperCfg, stderr *os.File) *proc {
	t.Helper()
	if h.TickMs == 0 {
		h.TickMs = 20
	}
	if h.Window == 0 {
		h.Window = time.Minute
	}
	data, _ := json.Marshal(h)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "POD_GOCACHE_HELPER=daemon", "POD_GOCACHE_HELPER_CONFIG="+string(data))
	p := &proc{cmd: cmd, stderr: &bytes.Buffer{}, done: make(chan int, 1)}
	if stderr != nil {
		cmd.Stderr = stderr
	} else {
		cmd.Stderr = p.stderr
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		err := cmd.Wait()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		p.done <- code
	}()
	t.Cleanup(func() { cmd.Process.Kill() })
	return p
}

func (p *proc) wait(t *testing.T, d time.Duration) int {
	t.Helper()
	select {
	case c := <-p.done:
		return c
	case <-time.After(d):
		t.Fatalf("process %d still running after %s", p.cmd.Process.Pid, d)
		return -1
	}
}

func (p *proc) term(t *testing.T) int {
	p.cmd.Process.Signal(syscall.SIGTERM)
	return p.wait(t, time.Minute) // a loaded machine finishes the tick late
}

func waitOwner(t *testing.T, stateDir string, pid int) {
	waitFor(t, time.Minute, "owner.json from pid "+strconv.Itoa(pid), func() bool {
		o, ok, err := ownerstate.ReadOwner(stateDir)
		return err == nil && ok && o.PID == pid
	})
}

// S25a: a second daemon on the same state dir exits 0 within a second with
// one line naming the holder, and changes nothing.
func TestDuplicateDaemonExits(t *testing.T) {
	cache, state := tempDir(t), tempDir(t)
	a := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9}, nil)
	waitOwner(t, state, a.cmd.Process.Pid)
	lockBefore, _ := os.ReadFile(filepath.Join(state, ownerstate.LockFile))
	startsBefore, _ := os.ReadFile(filepath.Join(state, ownerstate.StartFile))
	start := time.Now()
	b := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9}, nil)
	if code := b.wait(t, 5*time.Second); code != 0 {
		t.Errorf("duplicate exited %d", code)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("duplicate took %s to exit", d)
	}
	lines := strings.Split(strings.TrimSpace(b.stderr.String()), "\n")
	if len(lines) != 1 || !strings.Contains(lines[0], strconv.Itoa(a.cmd.Process.Pid)) {
		t.Errorf("duplicate stderr %q", b.stderr.String())
	}
	lockAfter, _ := os.ReadFile(filepath.Join(state, ownerstate.LockFile))
	startsAfter, _ := os.ReadFile(filepath.Join(state, ownerstate.StartFile))
	if !bytes.Equal(lockBefore, lockAfter) || !bytes.Equal(startsBefore, startsAfter) {
		t.Error("the duplicate changed daemon.lock or the start record")
	}
	if code := a.term(t); code != 0 {
		t.Errorf("SIGTERM exit %d", code)
	}
}

// A SIGTERM mid-batch in the emergency tier ends in shutdown well inside the
// plist's ExitTimeOut (10 s): exit 0 and owner.json in observe mode within 2 s,
// whether it lands in the plan loop or in removePending. Each removal is slow,
// so the batch alone would run to its 10 s FullBatchTime.
func TestSigtermMidBatchStopsFast(t *testing.T) {
	for _, phase := range []string{"plan loop", "removePending"} {
		t.Run(phase, func(t *testing.T) {
			cache, state := tempDir(t), tempDir(t)
			for i := 0; i < 400; i++ {
				putEntry(t, cache, 2000, 3*time.Hour)
			}
			setMode(t, state, "owner")
			mark := filepath.Join(tempDir(t), "mark")
			h := helperCfg{CacheDir: cache, StateDir: state, Free: 5e9, EvictPause: 20 * time.Millisecond, FullBatch: 4 * time.Second}
			if phase == "plan loop" {
				h.MarkAction = mark
			} else {
				h.MarkOutput = mark
			}
			p := spawnHelper(t, h, nil)
			waitFor(t, time.Minute, phase, func() bool { return exists(mark) })
			start := time.Now()
			p.cmd.Process.Signal(syscall.SIGTERM)
			code := p.wait(t, time.Minute)
			if d := time.Since(start); d > 2*time.Second {
				t.Errorf("stopped %s after SIGTERM, want under 2 s", d.Round(time.Millisecond))
			}
			if code != 0 {
				t.Errorf("exit %d, want 0; stderr %q", code, p.stderr.String())
			}
			o, ok, err := ownerstate.ReadOwner(state)
			if err != nil || !ok || o.Mode != ownerstate.ModeObserve || o.PID != p.cmd.Process.Pid {
				t.Errorf("owner.json %+v (ok %v, err %v), want observe from pid %d", o, ok, err, p.cmd.Process.Pid)
			}
			if st := readState(t, state); st.Extra.Phase != PhaseStopped || st.Extra.Tier != "emergency" {
				t.Errorf("state.json phase %q tier %q, want stopped in emergency", st.Extra.Phase, st.Extra.Tier)
			}
		})
	}
}

// S25b: two owners on one cache through different state dirs: only one
// deletes and writes trim.txt.
func TestTwoStateDirsOneOwner(t *testing.T) {
	cache := tempDir(t)
	for i := 0; i < 300; i++ {
		putEntry(t, cache, 2000, 3*time.Hour)
	}
	s1, s2 := tempDir(t), tempDir(t)
	setMode(t, s1, "owner")
	setMode(t, s2, "owner")
	a := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: s1, Free: 5e9}, nil)
	b := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: s2, Free: 5e9}, nil)
	time.Sleep(3 * time.Second)
	a.term(t)
	b.term(t)
	st1, st2 := readState(t, s1), readState(t, s2)
	owners := 0
	for _, st := range []ownerstate.State{st1, st2} {
		if st.Evictions.Count > 0 || st.Extra.TrimWrittenAt != 0 {
			owners++
		} else if !strings.Contains(st.Extra.ModeReason, "another daemon") {
			t.Errorf("the idle one says %q", st.Extra.ModeReason)
		}
	}
	if owners != 1 {
		t.Fatalf("%d daemons acted on one cache (evictions %d / %d)", owners, st1.Evictions.Count, st2.Evictions.Count)
	}
}

// Amendment 2: five unclean starts within ten minutes trip the breaker: one
// log line, state.json with the error, exit 0 so launchd stops respawning.
func TestCrashLoopBreaker(t *testing.T) {
	cache, state := tempDir(t), tempDir(t)
	for i := 1; i <= 4; i++ {
		p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9, CrashAfter: 300 * time.Millisecond}, nil)
		if code := p.wait(t, time.Minute); code == 0 {
			t.Fatalf("crash %d exited 0", i)
		}
		if i == 3 {
			if r := readState(t, state).Extra.Restarts; r != 2 {
				t.Errorf("third start shows %d restarts, want 2", r)
			}
		}
	}
	p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9}, nil)
	if code := p.wait(t, time.Minute); code != 0 {
		t.Fatalf("breaker exit %d, want 0", code)
	}
	if n := strings.Count(p.stderr.String(), "crash loop"); n != 1 {
		t.Errorf("%d crash-loop lines: %q", n, p.stderr.String())
	}
	st := readState(t, state)
	if st.Extra.Phase != "crash-loop" || !strings.Contains(st.Extra.Error, "crash loop") || st.Extra.Restarts != 5 {
		t.Errorf("state.json %+v", st.Extra)
	}
	// Pod's next launch starts fresh.
	q := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9}, nil)
	waitOwner(t, state, q.cmd.Process.Pid)
	if code := q.term(t); code != 0 {
		t.Errorf("after the breaker: exit %d", code)
	}
}

// S30 and S14: SIGKILL at random points and right between an executable's
// unlink and its rmdir, over and over. trim.txt is the only file ever
// created in the cache; an emptied executable dir never outlives a kept -a;
// owner.json and state.json always parse.
func TestKillLoopLeavesCacheClean(t *testing.T) {
	cache, state := tempDir(t), tempDir(t)
	for i := 0; i < 300; i++ {
		putEntry(t, cache, 3000, 3*time.Hour)
	}
	var execs []entryIDs
	for i := 0; i < 50; i++ {
		execs = append(execs, putExec(t, cache, 20000, 3*time.Hour))
	}
	setMode(t, state, "owner")
	before := snapshot(t, cache)
	rng := rand.New(rand.NewSource(1))
	execLeft := func() bool {
		for _, e := range execs {
			if _, d := e.paths(cache); exists(filepath.Join(d, "prog")) {
				return true
			}
		}
		return false
	}
	kills, innerKills, runs := 0, 0, 0
	for i := 0; i < 100; i++ {
		// First one kill per executable between its unlink and rmdir, then
		// 30 kills at random points.
		h := helperCfg{CacheDir: cache, StateDir: state, Free: 5e9, KillAfterInner: execLeft(), CrashAfter: time.Second}
		if !h.KillAfterInner {
			if i >= innerKills+30 {
				break
			}
			h.CrashAfter = time.Duration(rng.Intn(400)) * time.Millisecond
		} else {
			innerKills++
		}
		runs++
		p := spawnHelper(t, h, nil)
		code := p.wait(t, time.Minute)
		if code != 0 {
			kills++
		}
		for _, f := range []string{ownerstate.OwnerFile, ownerstate.StateFile} {
			if data, err := os.ReadFile(filepath.Join(state, f)); err == nil {
				var v map[string]any
				if json.Unmarshal(data, &v) != nil {
					t.Fatalf("%s torn after a kill: %q", f, data)
				}
			}
		}
		os.Remove(filepath.Join(state, ownerstate.StartFile)) // keep the breaker out of this test
	}
	after := snapshot(t, cache)
	for name := range after {
		if _, ok := before[name]; !ok && name != "trim.txt" {
			t.Errorf("%s created in the cache", name)
		}
	}
	for _, e := range execs {
		a, d := e.paths(cache)
		if ents, err := os.ReadDir(d); err == nil && len(ents) == 0 && exists(a) {
			t.Errorf("%s emptied while its -a remains", d)
		}
	}
	p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 5e9}, nil)
	waitOwner(t, state, p.cmd.Process.Pid)
	p.term(t)
	ents, _ := os.ReadDir(state)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp.") {
			t.Errorf("temp file %s left in the state dir", e.Name())
		}
	}
	if innerKills < 40 {
		t.Errorf("only %d runs killed between an unlink and its rmdir", innerKills)
	}
	t.Logf("%d of %d runs killed, %d of them between an executable's unlink and rmdir", kills, runs, innerKills)
}

// S28: no HOME and no flags: a clear error, a non-zero exit, nothing created
// relative to the working directory. A relative --cache-dir is refused.
func TestNoHome(t *testing.T) {
	cwd := tempDir(t)
	run := func(env []string, args ...string) (int, string) {
		cmd := exec.Command(os.Args[0], args...)
		cmd.Dir = cwd
		cmd.Env = append(env, "POD_GOCACHE_HELPER=cli")
		var errb bytes.Buffer
		cmd.Stderr = &errb
		err := cmd.Run()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		return code, errb.String()
	}
	var noHome []string
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "HOME=") {
			noHome = append(noHome, e)
		}
	}
	if code, msg := run(noHome); code == 0 || !strings.Contains(msg, "HOME") {
		t.Errorf("no HOME: exit %d %q", code, msg)
	}
	if code, msg := run(os.Environ(), "--cache-dir", "go-build", "--state-dir", tempDir(t)); code != ExitUsage || !strings.Contains(msg, "absolute") {
		t.Errorf("relative --cache-dir: exit %d %q", code, msg)
	}
	if ents, _ := os.ReadDir(cwd); len(ents) != 0 {
		t.Errorf("created in the working directory: %v", ents)
	}
}

// Amendment 2: the daemon rotates daemon.log itself (launchd holds the fd).
func TestLogRotation(t *testing.T) {
	cache, state := tempDir(t), tempDir(t)
	logPath := filepath.Join(state, ownerstate.LogFile)
	f, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	p := spawnHelper(t, helperCfg{CacheDir: cache, StateDir: state, Free: 50e9, LogMax: 2048}, f)
	waitOwner(t, state, p.cmd.Process.Pid)
	// Each switch logs a line; flip until the log passes LogMax and rotates
	// (a loaded machine notices fewer switches per second).
	deadline := time.Now().Add(30 * time.Second)
	for i := 0; i < 60 || (!exists(logPath+".1") && time.Now().Before(deadline)); i++ {
		setMode(t, state, []string{"owner", "observe"}[i%2])
		time.Sleep(40 * time.Millisecond)
	}
	p.term(t)
	old, err := os.Stat(logPath + ".1")
	if err != nil {
		t.Fatalf("no daemon.log.1: %v", err)
	}
	cur, _ := os.ReadFile(logPath)
	if old.Size() < 2048 || len(cur) == 0 || len(cur) > 2048+400 {
		t.Errorf("daemon.log.1 %d bytes, daemon.log %d bytes", old.Size(), len(cur))
	}
	if !strings.Contains(string(cur), "stop evicted=") {
		t.Errorf("the daemon stopped writing after rotating: %q", cur)
	}
}

// D8: --mode observe is a ceiling over the mode file, and test settings
// (window < 30 min or budget < 1 GB) never own os.UserCacheDir()/go-build.
// HOME is a temp dir here, so that path is a stand-in.
func TestModeCeilings(t *testing.T) {
	real, err := RealCacheDir()
	if err != nil || !strings.HasPrefix(real, os.Getenv("HOME")) {
		t.Fatalf("real cache dir %q is not under the test HOME", real)
	}
	os.MkdirAll(real, 0o777)
	e := putEntry(t, real, 1000, 3*time.Hour)
	for _, tc := range []struct {
		name, reason string
		tweak        func(*Config)
	}{
		{"test-settings", "test settings never own the real cache", func(c *Config) {}},
		{"mode-observe-flag", "--mode observe", func(c *Config) { c.CacheDir = tempDir(t); c.ObserveOnly = true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := fastConfig(t, real, 5_000_000_000)
			tc.tweak(&cfg)
			setMode(t, cfg.StateDir, "owner")
			stop := startRun(t, cfg)
			waitFor(t, time.Minute, "status", func() bool { return readState(t, cfg.StateDir).Extra.Phase == "ready" })
			time.Sleep(20 * cfg.Tick)
			stop()
			st := readState(t, cfg.StateDir)
			if st.Mode != ownerstate.ModeObserve || st.Extra.ModeReason != tc.reason {
				t.Errorf("mode %s (%q), want observe (%q)", st.Mode, st.Extra.ModeReason, tc.reason)
			}
			if a, d := e.paths(real); !exists(a) || !exists(d) || exists(filepath.Join(real, "trim.txt")) {
				t.Error("the guarded cache was changed")
			}
		})
	}
}
