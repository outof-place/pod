package daemon

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/procscan"
)

// End-to-end tests with the real go command on a temp GOCACHE, at scaled
// windows. Go's one-hour mtime refresh is compiled in, so fixtures are aged
// past an hour where a hit must refresh them and kept younger where it must
// not. POD_GOCACHE_E2E=1 runs them (a few minutes, real builds).

func requireE2E(t *testing.T) {
	if os.Getenv("POD_GOCACHE_E2E") == "" {
		t.Skip("set POD_GOCACHE_E2E=1 to run the real-go end-to-end tests")
	}
}

type e2e struct {
	t     *testing.T
	root  string
	cache string
	mod   string
	goBin string
	cfg   Config
	disk  *fixedDisk
	guard *guardFS
	mu    sync.Mutex
	evs   []Eviction
	evAt  []time.Time
	stop  func() int
	// S9: the daemon publishes under live; with client set, go runs through
	// that pod-gocache binary and its trace lands in trace.
	live, trace, client string
}

// guardFS lstat's every file itself just before the daemon's guarded unlink
// and, when the unlink happens, records how long the file had been idle: the
// window check reads this, not the daemon's own record.
type guardFS struct {
	cachefs.FS
	root    string
	mu      sync.Mutex
	removed []guarded
}

type guarded struct {
	rel  string
	idle time.Duration
}

// idle is how long rel (and the directory holding an executable) has been
// unused by an independent lstat: mtime for an -a, which the daemon reads
// itself, the newer of mtime and atime otherwise.
func (g *guardFS) idle(rel string) (time.Duration, bool) {
	var newest int64
	paths := []string{rel}
	if dir, _, inner := strings.Cut(rel[3:], "/"); inner {
		paths = append(paths, rel[:3]+dir)
	}
	for _, p := range paths {
		var st syscall.Stat_t
		if syscall.Lstat(filepath.Join(g.root, p), &st) != nil {
			return 0, false
		}
		rec := st.Mtimespec.Nano()
		if !strings.HasSuffix(p, "-a") && st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			rec = max(rec, st.Atimespec.Nano())
		}
		newest = max(newest, rec)
	}
	return time.Since(time.Unix(0, newest)), true
}

func (g *guardFS) note(rel string, idle time.Duration, ok bool, out cachefs.Outcome) {
	if out == cachefs.Removed && ok {
		g.mu.Lock()
		g.removed = append(g.removed, guarded{rel, idle})
		g.mu.Unlock()
	}
}

func (g *guardFS) RemoveIfIdle(rel string, ino uint64, cutoff int64) (cachefs.Outcome, cachefs.Stat, error) {
	idle, ok := g.idle(rel)
	out, st, err := g.FS.RemoveIfIdle(rel, ino, cutoff)
	g.note(rel, idle, ok, out)
	return out, st, err
}

func (g *guardFS) RemoveEmptyDir(rel string, cutoff int64) (cachefs.Outcome, error) {
	idle, ok := g.idle(rel)
	out, err := g.FS.RemoveEmptyDir(rel, cutoff)
	if cutoff != math.MaxInt64 { // the rmdir right after its executable's unlink was judged with it
		g.note(rel, idle, ok, out)
	}
	return out, err
}

func newE2E(t *testing.T, free int64) *e2e {
	requireE2E(t)
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go on PATH")
	}
	e := &e2e{t: t, root: tempDir(t), goBin: goBin, disk: newDisk(free)}
	e.cache, e.mod = filepath.Join(e.root, "gocache"), filepath.Join(e.root, "mod")
	e.live, e.trace = filepath.Join(e.root, "live"), filepath.Join(e.root, "trace")
	os.MkdirAll(e.mod, 0o777)
	if isRealCache(e.cache) {
		t.Fatal("refusing to run against the real cache")
	}
	return e
}

func (e *e2e) env() []string {
	var env []string
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "GO") || k == "CGO_ENABLED" || strings.HasPrefix(k, "POD_GOCACHE_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "GOCACHE="+e.cache, "GOENV=off", "GOTOOLCHAIN=local", "GOFLAGS=", "GOPROXY=off",
		"GOWORK=off", "CGO_ENABLED=0", "GOPATH="+filepath.Join(e.root, "gopath"), "GOTELEMETRY=off")
	if e.client != "" {
		env = append(env, "GOCACHEPROG="+e.client+" prog", "POD_GOCACHE_LIVE_DIR="+e.live, "POD_GOCACHE_TRACE_DIR="+e.trace)
	}
	return env
}

func (e *e2e) write(files map[string]string) {
	for name, body := range files {
		p := filepath.Join(e.mod, name)
		os.MkdirAll(filepath.Dir(p), 0o777)
		if err := os.WriteFile(p, []byte(body), 0o666); err != nil {
			e.t.Fatal(err)
		}
	}
}

func (e *e2e) cmd(bin string, args ...string) *exec.Cmd {
	c := exec.Command(bin, args...)
	c.Dir, c.Env = e.mod, e.env()
	return c
}

// run runs go and fails the test on any error.
func (e *e2e) run(args ...string) string {
	e.t.Helper()
	out, err := e.cmd(e.goBin, args...).CombinedOutput()
	if err != nil {
		e.t.Fatalf("go %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func (e *e2e) startDaemon(tweak func(*Config)) {
	cfg := fastConfig(e.t, e.cache, 0)
	cfg.Disk = e.disk
	e.guard = &guardFS{FS: cachefs.NewOS(e.cache), root: e.cache}
	cfg.FS = e.guard
	// Every e2e daemon publishes, so go's built-in cache (which, like an S1
	// client, never reads the shared state) runs beside a publishing daemon.
	cfg.LiveRoot, cfg.Shared = e.live, newFileShared(e.live, e.cache)
	cfg.OnEvict = func(ev Eviction) {
		e.mu.Lock()
		e.evs = append(e.evs, ev)
		e.evAt = append(e.evAt, time.Now())
		e.mu.Unlock()
	}
	if tweak != nil {
		tweak(&cfg)
	}
	setMode(e.t, cfg.StateDir, "owner")
	e.cfg = cfg
	e.stop = startRun(e.t, cfg)
	waitFor(e.t, 3*time.Minute, "the daemon to index", func() bool {
		return readState(e.t, cfg.StateDir).Extra.Phase == "ready"
	})
}

func (e *e2e) evictions() []Eviction {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]Eviction(nil), e.evs...)
}

// entries lists every managed file (an executable's inner file too).
func (e *e2e) entries() []string {
	var out []string
	filepath.WalkDir(e.cache, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(e.cache, p)
		if cachefs.Allowed(rel) {
			out = append(out, rel)
		}
		return nil
	})
	return out
}

// ageAll sets every entry's mtime and atime to d ago.
func (e *e2e) ageAll(d time.Duration) []string {
	rels := e.entries()
	for _, rel := range rels {
		setAge(e.t, filepath.Join(e.cache, rel), d)
	}
	return rels
}

// windowsRespected checks every unlink against the configured window for the
// fixed free disk, from the guard's own lstat just before it.
func (e *e2e) windowsRespected() {
	e.t.Helper()
	l, free := e.cfg.Limits, e.disk.free.Load()
	window := l.Window
	switch {
	case free < l.EmergencyFloor:
		window = l.EmergencyWindow
	case free < l.HardFloor:
		window = l.HardWindow
	}
	e.guard.mu.Lock()
	defer e.guard.mu.Unlock()
	for _, g := range e.guard.removed {
		if g.idle <= window {
			e.t.Errorf("%s removed after %s idle, inside the %s window", g.rel, g.idle.Round(time.Millisecond), window)
		}
	}
	if len(e.guard.removed) == 0 && len(e.evictions()) > 0 {
		e.t.Error("the guard saw no unlink although the daemon evicted")
	}
}

var goFailure = []string{"no such file", "could not import", "could not load export data", "invalid binary cache entry", "DO NOT USE"}

func failed(out string) string {
	for _, f := range goFailure {
		if strings.Contains(out, f) {
			return f
		}
	}
	return ""
}

// descendants lists only this test's own processes, so go builds of other
// sessions on the machine don't widen the window.
type descendants struct{}

func (descendants) List() ([]procscan.Proc, error) {
	all, err := procscan.Sysctl{}.List()
	if err != nil {
		return nil, err
	}
	parent := map[int32]int32{}
	for _, p := range all {
		parent[p.PID] = p.PPID
	}
	me := int32(os.Getpid())
	var out []procscan.Proc
	for _, p := range all {
		for pid, n := p.PPID, 0; pid > 1 && n < 64; pid, n = parent[pid], n+1 {
			if pid == me {
				out = append(out, p)
				break
			}
		}
	}
	return out, nil
}

// S1: a build outlives the window while the files it looked up are younger
// than Go's hourly refresh. The link reads them after the window; the
// process-aware window keeps them, and without it the link fails.
func TestE2ES1LongBuild(t *testing.T) {
	for _, withProcs := range []bool{true, false} {
		t.Run(fmt.Sprintf("process-window-%v", withProcs), func(t *testing.T) {
			e := newE2E(t, 12_000_000_000)
			sleeper := filepath.Join(e.root, "slow-compile")
			os.WriteFile(sleeper, []byte("#!/bin/sh\ncase \" $* \" in *\" -p e2e/s \"*) sleep \"${SLOW_S:-0}\";; esac\nexec \"$@\"\n"), 0o755)
			e.write(map[string]string{
				"go.mod":   "module e2e\n\ngo 1.27\n",
				"d/d.go":   "package d\n\nfunc D() int { return 41 }\n",
				"s/s.go":   "package s\n\nfunc S() int { return 1 }\n",
				"main.go":  "package main\n\nimport (\n\t\"fmt\"\n\t\"e2e/d\"\n\t\"e2e/s\"\n)\n\nfunc main() { fmt.Println(d.D() + s.S()) }\n",
				"x/x.go":   "package x\n",
				"x/README": "unused\n",
			})
			tx := "-toolexec=" + sleeper
			e.run("build", tx, "./d", "fmt")
			const window = 20 * time.Second
			e.startDaemon(func(c *Config) {
				c.Limits.Window, c.Limits.HardWindow, c.Limits.EmergencyWindow = window, window/2, window/4
				c.Limits.ProcessMargin, c.Limits.GoRunCap, c.Limits.ExitGrace = window+5*time.Second, time.Hour, 0
				c.Procs = descendants{}
				if !withProcs {
					c.Procs = noProcs{}
				}
			})
			e.ageAll(window - 5*time.Second) // younger than an hour: lookups won't refresh
			c := e.cmd(e.goBin, "build", tx, "-o", filepath.Join(e.root, "app"), ".")
			c.Env = append(c.Env, "SLOW_S=30")
			out, err := c.CombinedOutput()
			e.stop()
			if withProcs {
				if err != nil {
					t.Fatalf("build failed with the process-aware window: %v\n%s", err, out)
				}
				e.windowsRespected()
				return
			}
			if err == nil {
				t.Fatalf("sabotage: without the process term the build still succeeded; the test proves nothing (%d evictions)", len(e.evictions()))
			}
			t.Logf("without the process term: %s", strings.TrimSpace(string(out))[:min(200, len(strings.TrimSpace(string(out))))])
		})
	}
}

// fixture220 writes a module of 220 packages that import each other, with
// tests in 20 of them.
func fixture220(e *e2e) {
	files := map[string]string{"go.mod": "module e2e\n\ngo 1.27\n"}
	for i := 0; i < 220; i++ {
		var imports, sum []string
		for _, d := range []int{1, 7, 31} {
			if j := i - d; j >= 0 {
				imports = append(imports, fmt.Sprintf("\t\"e2e/p%03d\"", j))
				sum = append(sum, fmt.Sprintf("p%03d.V", j))
			}
		}
		body := fmt.Sprintf("package p%03d\n\n", i)
		if len(imports) > 0 {
			body += "import (\n" + strings.Join(imports, "\n") + "\n)\n\n"
		}
		sum = append(sum, fmt.Sprint(i))
		// A package variable, not a call chain: F calling its imports' F is
		// exponential in the depth and never finishes.
		body += fmt.Sprintf("var V = (%s) %% 1000003\n\nfunc F() int { return V }\n\ntype T%d struct{ A, B int }\n\nfunc (t T%d) Sum() int { return t.A + t.B + F() }\n", strings.Join(sum, " + "), i, i)
		files[fmt.Sprintf("p%03d/p.go", i)] = body
		if i%11 == 0 {
			files[fmt.Sprintf("p%03d/p_test.go", i)] = fmt.Sprintf("package p%03d\n\nimport \"testing\"\n\nfunc TestF(t *testing.T) {\n\tif F() < 0 {\n\t\tt.Fatal(F())\n\t}\n}\n", i)
		}
	}
	files["main.go"] = "package main\n\nimport \"e2e/p219\"\n\nfunc main() { println(p219.F()) }\n"
	e.write(files)
}

// S2: ten loops of build, vet, test and list -export over a 220-package
// module while the daemon evicts at 6 GB free (fake) from entries aged 3 h.
// Every go command succeeds, every Export path still opens 30 s after its
// go list exits, and at least a tenth of the aged entries goes meanwhile.
func TestE2ES2RevivalRace(t *testing.T) {
	e := newE2E(t, 6_000_000_000)
	aged := e.revivalSetup()
	r := e.revivalRace(e2eRounds(6))
	e.stop()
	e.revivalChecks(aged, r, true)
}

// revivalSetup warms the 220-package fixture, ages every entry 3 h and
// starts the daemon with minute-scale windows; it returns the aged entries.
func (e *e2e) revivalSetup() map[string]bool {
	fixture220(e)
	e.run("build", "./...")
	e.run("vet", "./...")
	e.run("test", "-count=1", "./...")
	e.run("list", "-export", "-deps", "-json", "./...")
	aged := map[string]bool{}
	for _, rel := range e.ageAll(3 * time.Hour) {
		aged[rel] = true
	}
	e.startDaemon(func(c *Config) {
		c.Limits.Window, c.Limits.HardWindow, c.Limits.EmergencyWindow = 4*time.Minute, 2*time.Minute, time.Minute
		c.Procs = descendants{}
	})
	return aged
}

// raceResult is what the revival loops saw.
type raceResult struct {
	goFailures []string
	reads      int
	rereads    []rereadFail // export files gone 30 s after their go list exited
}

type rereadFail struct {
	path     string
	listExit time.Time
	err      error
}

// revivalRace runs ten loops of rounds go commands each, re-reading every
// Export path 30 s after its go list exits.
func (e *e2e) revivalRace(rounds int) raceResult {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var r raceResult
	cmds := [][]string{{"build", "./..."}, {"vet", "./..."}, {"test", "-count=1", "./..."}, {"list", "-export", "-deps", "-json", "./..."}}
	for loop := 0; loop < 10; loop++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for round := 0; round < rounds; round++ {
				args := cmds[(loop+round)%len(cmds)]
				out, err := e.cmd(e.goBin, args...).CombinedOutput()
				exit := time.Now()
				if f := failed(string(out)); err != nil || f != "" {
					mu.Lock()
					r.goFailures = append(r.goFailures, fmt.Sprintf("go %s: %v %s\n%s", strings.Join(args, " "), err, f, out[:min(len(out), 600)]))
					mu.Unlock()
					continue
				}
				if args[0] != "list" {
					continue
				}
				exports := exportPaths(out)
				wg.Add(1)
				go func() {
					defer wg.Done()
					time.Sleep(30 * time.Second)
					for _, p := range exports {
						f, err := os.Open(p)
						if err == nil {
							_, err = io.Copy(io.Discard, f)
							f.Close()
						}
						mu.Lock()
						r.reads++
						if err != nil {
							r.rereads = append(r.rereads, rereadFail{p, exit, err})
						}
						mu.Unlock()
					}
				}()
			}
		}()
	}
	wg.Wait()
	return r
}

// lastEviction is the daemon's last removal of path.
func (e *e2e) lastEviction(path string) (Eviction, bool) {
	rel, _ := filepath.Rel(e.cache, path)
	var last Eviction
	found := false
	for _, ev := range e.evictions() {
		if ev.Rel == rel {
			last, found = ev, true
		}
	}
	return last, found
}

// e2eRounds is POD_GOCACHE_E2E_ROUNDS, else def.
func e2eRounds(def int) int {
	if n, err := strconv.Atoi(os.Getenv("POD_GOCACHE_E2E_ROUNDS")); err == nil && n > 0 {
		return n
	}
	return def
}

// revivalChecks fails on any go failure and, with strict, on any export file
// gone at its reread. Without strict, an export file may be gone if the
// daemon removed it after its go list exited (then nothing pinned it: the
// emergency tier ignores processes); removed earlier, or by someone else, is
// a failure.
func (e *e2e) revivalChecks(aged map[string]bool, r raceResult, strict bool) {
	t := e.t
	t.Helper()
	for _, f := range r.goFailures[:min(5, len(r.goFailures))] {
		t.Error(f)
	}
	bad, late := 0, 0
	for _, f := range r.rereads {
		ev, ok := e.lastEviction(f.path)
		why := ""
		switch {
		case strict:
			why = "gone"
		case !ok:
			why = "gone, not removed by the daemon"
		case time.Unix(0, ev.Wall).Before(f.listExit.Add(-time.Second)):
			why = fmt.Sprintf("removed %s before its go list exited (idle %s, window %s, %s tier)",
				f.listExit.Sub(time.Unix(0, ev.Wall)).Round(time.Millisecond), ev.Age.Round(time.Millisecond), ev.Window, ev.Tier)
		default:
			late++
			continue
		}
		if bad++; bad <= 5 {
			t.Errorf("export reread: %v: %s", f.err, why)
		}
	}
	e.windowsRespected()
	evicted := 0
	for _, ev := range e.evictions() {
		if aged[ev.Rel] {
			evicted++
		}
	}
	// The race is real only if eviction ran alongside the loops: 17 to 55% of
	// the aged entries went in measured runs, fewer when the machine is busy.
	if evicted*10 < len(aged) {
		t.Errorf("only %d of %d aged entries evicted while the loops ran", evicted, len(aged))
	}
	t.Logf("%d aged entries, %d evicted during the loops, %d export rereads (%d gone: %d removed after their go list exited, %d failures), %d go failures",
		len(aged), evicted, r.reads, len(r.rereads), late, bad, len(r.goFailures))
}

func exportPaths(out []byte) []string {
	var paths []string
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for {
		var p struct{ Export string }
		if dec.Decode(&p) != nil {
			return paths
		}
		if p.Export != "" {
			paths = append(paths, p.Export)
		}
	}
}

// S10: export data read by a non-go process after go list exited, at +5,
// +30 and +45 s with a 60 s window: the window alone keeps them.
func TestE2ES10ExportReaders(t *testing.T) {
	e := newE2E(t, 12_000_000_000)
	fixture220(e)
	e.run("list", "-export", "-deps", "-json", "./...")
	e.ageAll(2 * time.Hour) // past an hour: go list refreshes what it uses
	e.startDaemon(func(c *Config) {
		c.Limits.Window, c.Limits.HardWindow, c.Limits.EmergencyWindow = time.Minute, 30*time.Second, 15*time.Second
		// Only the window may protect the readers here: no margin or grace
		// from the go list process once it is gone.
		c.Limits.ProcessMargin, c.Limits.ExitGrace = 5*time.Second, 0
		c.Procs = descendants{}
	})
	exports := exportPaths([]byte(e.run("list", "-export", "-deps", "-json", "./...")))
	start := time.Now()
	for _, at := range []time.Duration{5 * time.Second, 30 * time.Second, 45 * time.Second} {
		time.Sleep(time.Until(start.Add(at)))
		for _, p := range exports {
			if _, err := os.ReadFile(p); err != nil {
				t.Fatalf("+%s: %v", at, err)
			}
		}
	}
	time.Sleep(time.Until(start.Add(80 * time.Second)))
	e.stop()
	gone := 0
	for _, p := range exports {
		if !exists(p) {
			gone++
		}
	}
	if gone == 0 {
		t.Error("no export file evicted after the window: the run proves nothing")
	}
	e.windowsRespected()
	t.Logf("%d export files read three times; %d evicted after the window", len(exports), gone)
}

// S14: go run and go tool executables. Evicted -a first, then the file, then
// the directory; go run relinks afterwards; a daemon SIGKILLed between the
// unlink and the rmdir never makes go run fail; a running program whose
// executable is evicted keeps running.
func TestE2ES14Executables(t *testing.T) {
	e := newE2E(t, 12_000_000_000)
	e.write(map[string]string{
		"go.mod":             "module e2e\n\ngo 1.27\n\ntool e2e/cmd/tooly\n",
		"cmd/x/main.go":      "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"x ok\") }\n",
		"cmd/tooly/main.go":  "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"tooly ok\") }\n",
		"cmd/server/main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"time\"\n)\n\nfunc main() {\n\ttime.Sleep(8 * time.Second)\n\tfmt.Println(\"server done\")\n}\n",
	})
	if out := e.run("run", "./cmd/x"); !strings.Contains(out, "x ok") {
		t.Fatalf("go run: %q", out)
	}
	if out := e.run("tool", "tooly"); !strings.Contains(out, "tooly ok") {
		t.Fatalf("go tool: %q", out)
	}
	execs := e.execDirs()
	if len(execs) < 2 {
		t.Fatalf("expected executable -d dirs for go run and go tool, found %v", execs)
	}
	e.ageAll(2 * time.Minute)
	for _, d := range execs {
		setAge(t, filepath.Join(e.cache, d), 2*time.Minute)
	}
	e.startDaemon(func(c *Config) { c.Procs = descendants{} })
	waitFor(t, 2*time.Minute, "executables evicted", func() bool {
		for _, d := range execs {
			if exists(filepath.Join(e.cache, d)) {
				return false
			}
		}
		return true
	})
	e.stop()
	e.windowsRespected()
	inner := 0
	for _, ev := range e.evictions() {
		if strings.Contains(ev.Rel, "-d/") {
			inner++
		}
	}
	if inner < len(execs) {
		t.Errorf("%d executable removals recorded for %d dirs", inner, len(execs))
	}
	if out := e.run("run", "./cmd/x"); !strings.Contains(out, "x ok") {
		t.Fatalf("go run after eviction: %q", out)
	}

	// SIGKILL between the inner unlink and the rmdir, then go run.
	for i := 0; i < 10; i++ {
		e.ageAll(2 * time.Minute)
		for _, d := range e.execDirs() {
			setAge(t, filepath.Join(e.cache, d), 2*time.Minute)
		}
		state := tempDir(t)
		setMode(t, state, "owner")
		p := spawnHelper(t, helperCfg{CacheDir: e.cache, StateDir: state, Free: 12e9, KillAfterInner: true, CrashAfter: 5 * time.Second}, nil)
		p.wait(t, 20*time.Second)
		out, err := e.cmd(e.goBin, "run", "./cmd/x").CombinedOutput()
		if err != nil || failed(string(out)) != "" || !strings.Contains(string(out), "x ok") {
			t.Fatalf("go run after a kill between unlink and rmdir (round %d): %v\n%s", i, err, out)
		}
	}

	// A running program keeps running when its executable goes.
	srv := e.cmd(e.goBin, "run", "./cmd/server")
	var out strings.Builder
	srv.Stdout, srv.Stderr = &out, &out
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second) // built and running
	e.ageAll(2 * time.Minute)
	for _, d := range e.execDirs() {
		setAge(t, filepath.Join(e.cache, d), 2*time.Minute)
	}
	e.startDaemon(func(c *Config) { c.Procs = noProcs{} })
	waitFor(t, 2*time.Minute, "the running program's executable evicted", func() bool { return len(e.execDirs()) == 0 })
	err := srv.Wait()
	e.stop()
	if err != nil || !strings.Contains(out.String(), "server done") {
		t.Fatalf("running program after its executable was evicted: %v %q", err, out.String())
	}
}

func (e *e2e) execDirs() []string {
	var dirs []string
	buckets, _ := os.ReadDir(e.cache)
	for _, b := range buckets {
		names, _ := os.ReadDir(filepath.Join(e.cache, b.Name()))
		for _, n := range names {
			if n.IsDir() && strings.HasSuffix(n.Name(), "-d") {
				dirs = append(dirs, b.Name()+"/"+n.Name())
			}
		}
	}
	return dirs
}

// S15: with the daemon owning trim.txt, entries idle 6 days survive a real
// build by go 1.27.2 and by go 1.24.13 (when its toolchain is in the module
// cache), also after a periodic rewrite. Without the daemon go trims them.
func TestE2ES15TrimSuppressed(t *testing.T) {
	gos := map[string]string{"go1.27": ""}
	home := os.Getenv("POD_GOCACHE_REAL_HOME")
	go124 := filepath.Join(home, "go", "pkg", "mod", "golang.org", "toolchain@v0.0.1-go1.24.13.darwin-arm64", "bin", "go")
	if exists(go124) {
		gos["go1.24"] = go124
	} else {
		t.Logf("go1.24.13 not in the module cache (%s): checking go1.27.2 only", go124)
	}
	setup := func() (*e2e, []string) {
		e := newE2E(t, 50_000_000_000)
		e.write(map[string]string{
			"go.mod": "module e2e\n\ngo 1.24\n",
			"a/a.go": "package a\n\nfunc A() int { return 1 }\n",
			"b/b.go": "package b\n\nfunc B() int { return 2 }\n",
		})
		e.run("build", "./a")
		before := map[string]bool{}
		for _, rel := range e.entries() {
			before[rel] = true
		}
		e.run("build", "./b")
		var onlyA []string
		for rel := range before {
			onlyA = append(onlyA, rel)
		}
		e.ageAll(6 * 24 * time.Hour)
		// Go's last trim two days ago: the next go command trims.
		os.WriteFile(filepath.Join(e.cache, "trim.txt"), []byte(fmt.Sprint(time.Now().Add(-48*time.Hour).Unix())), 0o666)
		return e, onlyA
	}
	survivors := func(e *e2e, rels []string) int {
		n := 0
		for _, rel := range rels {
			if exists(filepath.Join(e.cache, rel)) {
				n++
			}
		}
		return n
	}

	ctl, ctlRels := setup()
	ctl.run("build", "./b")
	if n := survivors(ctl, ctlRels); n == len(ctlRels) {
		t.Fatalf("control: go did not trim 6-day-old entries without the daemon (%d kept)", n)
	}

	e, rels := setup()
	e.startDaemon(func(c *Config) {
		c.Limits = evict.Defaults()
		c.TrimEvery = 2 * time.Second
	})
	time.Sleep(time.Second)
	for round := 0; round < 2; round++ {
		for name, bin := range gos {
			args := []string{"build", "./b"}
			var out []byte
			var err error
			if bin == "" {
				out, err = e.cmd(e.goBin, args...).CombinedOutput()
			} else {
				out, err = e.cmd(bin, args...).CombinedOutput()
			}
			if err != nil {
				t.Fatalf("%s build: %v\n%s", name, err, out)
			}
			if n := survivors(e, rels); n != len(rels) {
				t.Fatalf("round %d, %s: %d of %d six-day-old entries trimmed by go despite trim.txt", round, name, len(rels)-n, len(rels))
			}
		}
		time.Sleep(3 * time.Second) // a periodic rewrite in between
	}
	e.stop()
	data, _ := os.ReadFile(filepath.Join(e.cache, "trim.txt"))
	t.Logf("trim.txt %q; %d entries kept by %d toolchains over two rounds", strings.TrimSpace(string(data)), len(rels), len(gos))
}

// S17: go clean -cache under a running daemon: no crash or loop, the next
// rescan sees the rebuild, rebuilt entries are evicted past the window, and
// clean's removals are not counted as evictions.
func TestE2ES17GoClean(t *testing.T) {
	e := newE2E(t, 12_000_000_000)
	fixture220(e)
	e.run("build", "./...")
	e.startDaemon(func(c *Config) {
		c.Limits.Window, c.Limits.HardWindow, c.Limits.EmergencyWindow = 20*time.Second, 10*time.Second, 5*time.Second
		c.Limits.ProcessMargin, c.Limits.ExitGrace = 25*time.Second, 0 // scaled with the window
		c.Procs = descendants{}
	})
	e.run("clean", "-cache")
	countAfterClean := readState(t, e.cfg.StateDir).Evictions.Count
	e.run("build", "./...")
	built := len(e.entries())
	waitFor(t, time.Minute, "the rescan to see the rebuild", func() bool {
		st := readState(t, e.cfg.StateDir)
		return st.Entries != nil && *st.Entries >= int64(built)*9/10
	})
	if n := readState(t, e.cfg.StateDir).Evictions.Count; n != countAfterClean {
		t.Errorf("evictions %d -> %d before anything was old enough: clean counted", countAfterClean, n)
	}
	deadline := time.Now().Add(4 * time.Minute)
	for len(e.entries()) >= built/10 {
		if time.Now().After(deadline) {
			st := readState(t, e.cfg.StateDir)
			t.Fatalf("rebuilt entries not evicted: %d of %d left; state %+v\nlog:\n%s", len(e.entries()), built, st.Extra, tail(e.cfg.Log.(*lockedBuf).String(), 4000))
		}
		time.Sleep(100 * time.Millisecond)
	}
	e.stop()
	e.windowsRespected()
	log := e.cfg.Log.(*lockedBuf).String()
	if n := strings.Count(log, "reindexing"); n > 3 {
		t.Errorf("%d reindex lines", n)
	}
	sc := bufio.NewScanner(strings.NewReader(log))
	for sc.Scan() {
		if strings.Contains(sc.Text(), "panic") {
			t.Errorf("log: %s", sc.Text())
		}
	}
}
