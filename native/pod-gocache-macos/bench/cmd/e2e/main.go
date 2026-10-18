// Command e2e runs real charter-service go commands against the built-in cache and against
// cmd/passprog, interleaved round by round, each admitted by the machine scheduler and timed by
// cmd/goshim. It prints a markdown summary and appends every run to <out>/<scenario>.jsonl.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"pod-gocache-macos/bench/internal/machstate"
	"pod-gocache-macos/bench/internal/nativecache"
)

// clientModes maps a mode name to passprog flags; "builtin" means no GOCACHEPROG.
var clientModes = map[string][]string{
	"builtin":       nil,
	"client":        {"-put=decode", "-decoder=neon", "-write=pwrite"},
	"client-par":    {"-put=decode", "-decoder=neon", "-write=pwrite", "-workers=8"},
	"dedupe":        {"-put=dedupe", "-decoder=neon", "-write=pwrite"},
	"neon-mmap":     {"-put=decode", "-decoder=neon", "-write=mmap"},
	"neon-pwrite":   {"-put=decode", "-decoder=neon", "-write=pwrite"},
	"stdlib-pwrite": {"-put=decode", "-decoder=stdlib", "-write=pwrite"},
	// The module index (cmd/go/internal/modindex) is most of the gets of a warm go command.
	"builtin-noindex": nil,
	"client-noindex":  {"-put=decode", "-decoder=neon", "-write=pwrite"},
	// pod-gocache itself (-pgc), under /usr/bin/time -l for its CPU and memory:
	// S1 with the shared state off, S9 on the fast path of the daemon publishing in -live.
	"pgc-s1": nil,
	"pgc-s9": nil,
}

// modeEnv is extra environment per mode.
var modeEnv = map[string][]string{
	"builtin-noindex": {"GODEBUG=goindex=0"},
	"client-noindex":  {"GODEBUG=goindex=0"},
}

type shimRecord struct {
	Args     []string `json:"args"`
	Start    int64    `json:"start"`
	End      int64    `json:"end"`
	WallS    float64  `json:"wall_s"`
	UserS    float64  `json:"user_s"`
	SysS     float64  `json:"sys_s"`
	MaxRSSMB float64  `json:"max_rss_mb"`
	Exit     int      `json:"exit"`
	Signal   string   `json:"signal,omitempty"`
}

type runRecord struct {
	Scenario string             `json:"scenario"`
	Mode     string             `json:"mode"`
	Round    int                `json:"round"` // -1 for warm-up and discovery runs
	Before   machstate.Snapshot `json:"before"`
	Go       shimRecord         `json:"go"`
	Client   *clientStats       `json:"client,omitempty"`
	Phases   *phases            `json:"phases,omitempty"`
	OK       bool               `json:"ok"`
	Note     string             `json:"note,omitempty"`
	Log      string             `json:"log"`
}

type harness struct {
	scenario, src, gocache, prog, shim, out, goflags string
	pgc, live                                        string
	args                                             []string
	target                                           *putTarget
	trace                                            bool
	runID                                            string // keeps logs of separate invocations apart
	seq                                              int
	results                                          *os.File
}

func main() {
	h := &harness{runID: time.Now().Format("20060102-150405")}
	flag.StringVar(&h.scenario, "scenario", "warm-test", "warm-build | warm-test | put")
	flag.StringVar(&h.src, "src", "/tmp/podgc-s0/src/apps/charter-service", "charter-service checkout (a snapshot, never the live repo)")
	flag.StringVar(&h.gocache, "gocache", "/tmp/podgc-s0/gocache", "GOCACHE clone used by every mode")
	flag.StringVar(&h.prog, "prog", "/tmp/podgc-s0/bin/passprog", "passprog binary")
	flag.StringVar(&h.pgc, "pgc", "/tmp/podgc-s0/bin/pod-gocache", "pod-gocache binary for the pgc-* modes")
	flag.StringVar(&h.live, "live", "/tmp/podgc-s0/live", "POD_GOCACHE_LIVE_DIR of the daemon publishing for -gocache (pgc-s9)")
	flag.StringVar(&h.shim, "shim", "/tmp/podgc-s0/shim", "directory holding goshim installed as \"go\"")
	flag.StringVar(&h.out, "out", "/tmp/podgc-s0/e2e", "results directory")
	flag.StringVar(&h.goflags, "goflags", "-p=2 -trimpath", "GOFLAGS for every run (the sessions' go env value)")
	modeList := flag.String("modes", "builtin,client", "comma-separated modes: "+strings.Join(modeNames(), ","))
	runs := flag.Int("runs", 5, "measured rounds; each round runs every mode once, rotated")
	warmup := flag.Int("warmup", 1, "unmeasured rounds before the measured ones")
	flag.BoolVar(&h.trace, "trace", false, "add -debug-trace and split each run into before-link, link and after-link")
	gcflag := flag.String("gcflag", "charter-service/internal/handlers=-c=4", "put scenario: per-package flag that gives handlers a fresh action ID")
	flag.Parse()

	modes := strings.Split(*modeList, ",")
	for _, m := range modes {
		if _, ok := clientModes[m]; !ok {
			fatal("unknown mode %q", m)
		}
	}
	switch h.scenario {
	case "warm-build":
		h.args = []string{"build", "-o", "/dev/null", "./cmd"}
	case "warm-test":
		h.args = []string{"test", "-run", "^$", "./internal/handlers"}
	case "put":
		h.args = []string{"build", "-gcflags=" + *gcflag, "./internal/handlers"}
	default:
		fatal("unknown scenario %q", h.scenario)
	}
	// Explicit -p keeps the scheduler from choosing its own parallelism for us.
	for _, f := range strings.Fields(h.goflags) {
		if strings.HasPrefix(f, "-p=") {
			h.args = append([]string{h.args[0], f}, h.args[1:]...)
		}
	}
	if err := os.MkdirAll(filepath.Join(h.out, "logs"), 0o755); err != nil {
		fatal("%v", err)
	}
	var err error
	h.results, err = os.OpenFile(filepath.Join(h.out, h.scenario+".jsonl"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		fatal("%v", err)
	}
	fmt.Printf("# %s\n\n%s\n\nPortivo %s, go %s, GOFLAGS %q, command: go %s\n\n",
		h.scenario, machstate.Header(), portivoCommit(h.src), goVersion(), h.goflags, strings.Join(h.args, " "))

	if h.scenario == "put" {
		h.target = h.discover()
	}
	var all []runRecord
	for w := 0; w < *warmup; w++ {
		for _, m := range modes {
			h.run(m, -1)
		}
	}
	for r := 0; r < *runs; r++ {
		for i := range modes {
			all = append(all, h.run(modes[(i+r)%len(modes)], r))
		}
	}
	report(os.Stdout, h.scenario, modes, all)
}

func modeNames() []string {
	var out []string
	for k := range clientModes {
		out = append(out, k)
	}
	return out
}

func (h *harness) run(mode string, round int) runRecord {
	h.seq++
	tag := fmt.Sprintf("%s-%s-%03d-%s-r%d", h.scenario, h.runID, h.seq, mode, round)
	rec := runRecord{Scenario: h.scenario, Mode: mode, Round: round, Log: filepath.Join(h.out, "logs", tag+".out")}
	timing := filepath.Join(h.out, "logs", tag+".timing")
	clog := filepath.Join(h.out, "logs", tag+".prog.jsonl")
	trace := filepath.Join(h.out, "logs", tag+".trace.json")
	args := h.args
	if h.trace {
		args = append([]string{args[0], "-debug-trace=" + trace}, args[1:]...)
	}
	if h.target != nil {
		h.target.reset(mode == "dedupe")
	}
	env := []string{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "GOCACHE", "GOCACHEPROG", "GOFLAGS", "PATH", "PODGC_TIMING", "GOEXPERIMENT", "GODEBUG":
			continue
		}
		if strings.HasPrefix(k, "POD_GOCACHE_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "GOCACHE="+h.gocache, "GOFLAGS="+h.goflags, "PODGC_TIMING="+timing,
		"PATH="+h.shim+":"+os.Getenv("PATH"))
	env = append(env, modeEnv[mode]...)
	pgcTrace := filepath.Join(h.out, "logs", tag+".pgctrace")
	switch mode {
	case "pgc-s1":
		env = append(env, "GOCACHEPROG=/usr/bin/time -l "+h.pgc+" prog", "POD_GOCACHE_TRACE_DIR="+pgcTrace, "POD_GOCACHE_LIVE=off")
	case "pgc-s9":
		env = append(env, "GOCACHEPROG=/usr/bin/time -l "+h.pgc+" prog", "POD_GOCACHE_TRACE_DIR="+pgcTrace, "POD_GOCACHE_LIVE_DIR="+h.live)
	}
	if flags := clientModes[mode]; flags != nil {
		env = append(env, "GOCACHEPROG="+strings.Join(append([]string{h.prog, "-dir", h.gocache, "-log", clog}, flags...), " "))
	}
	logf, err := os.Create(rec.Log)
	if err != nil {
		fatal("%v", err)
	}
	defer logf.Close()
	rec.Before = machstate.Take()
	start := time.Now()
	for attempt := 0; ; attempt++ {
		cmd := exec.Command("claude-acc", append([]string{"run", "--", "go"}, args...)...)
		cmd.Dir, cmd.Env, cmd.Stdout, cmd.Stderr = h.src, env, logf, logf
		err = cmd.Run()
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 75 && attempt < 3 {
			fmt.Fprintf(logf, "\n[e2e] scheduler queue timeout (75), retrying\n")
			continue
		}
		break
	}
	rec.Go = readShim(timing)
	rec.OK = err == nil && rec.Go.Exit == 0 && rec.Go.WallS > 0
	if !rec.OK {
		rec.Note = fmt.Sprintf("go failed: %v exit=%d signal=%s (see %s)", err, rec.Go.Exit, rec.Go.Signal, rec.Log)
	}
	if clientModes[mode] != nil {
		rec.Client = summarizeClient(clog)
	}
	if strings.HasPrefix(mode, "pgc-") {
		rec.Client = summarizePgc(pgcTrace, rec.Log)
		os.RemoveAll(pgcTrace)
	}
	if h.trace && rec.OK {
		rec.Phases = splitAtLink(trace, rec.Go)
		os.Remove(trace) // tens of MB each; the split is kept in the results
	}
	if rec.OK && h.target != nil {
		if note := h.target.verify(mode, rec.Client, start); note != "" {
			rec.OK, rec.Note = false, note
		}
	}
	b, _ := json.Marshal(rec)
	h.results.Write(append(b, '\n'))
	status := "ok"
	if !rec.OK {
		status = "FAILED: " + rec.Note
	}
	fmt.Fprintf(os.Stderr, "[e2e] %s %.2fs (%s) %s\n", tag, rec.Go.WallS, rec.Before, status)
	return rec
}

func readShim(path string) shimRecord {
	var last shimRecord
	f, err := os.Open(path)
	if err != nil {
		return last
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r shimRecord
		// The scheduler may call `go env` through the shim too; keep the measured command.
		if json.Unmarshal(sc.Bytes(), &r) == nil && len(r.Args) > 0 && r.Args[0] != "env" {
			last = r
		}
	}
	return last
}

// putTarget is the handlers compile entry the put scenario deletes before every run.
type putTarget struct {
	dir            string
	action, output []byte
	size           int64
}

func (h *harness) discover() *putTarget {
	rec := h.run("neon-pwrite", -1)
	if !rec.OK || rec.Client == nil || rec.Client.Big == nil || rec.Client.Big.Size < 100e6 {
		fatal("discovery run did not put a large handlers archive (was it a cache hit? try another -gcflag value): %+v", rec)
	}
	t := &putTarget{dir: h.gocache, size: rec.Client.Big.Size}
	fmt.Sscanf(rec.Client.Big.Action, "%x", &t.action)
	fmt.Sscanf(rec.Client.Big.Output, "%x", &t.output)
	fmt.Printf("put target: action %x output %x, %d bytes\n\n", t.action, t.output, t.size)
	return t
}

func (t *putTarget) reset(keepOutput bool) {
	os.Remove(nativecache.FileName(t.dir, t.action, "a"))
	if !keepOutput {
		os.Remove(nativecache.FileName(t.dir, t.output, "d"))
	}
}

func (t *putTarget) verify(mode string, c *clientStats, start time.Time) string {
	st, err := os.Stat(nativecache.FileName(t.dir, t.action, "a"))
	if err != nil || st.ModTime().Before(start.Add(-time.Second)) {
		return "handlers action entry was not rewritten by this run"
	}
	if d, err := os.Stat(nativecache.FileName(t.dir, t.output, "d")); err != nil || d.Size() != t.size {
		return "handlers output missing or a different size (non-deterministic compile?)"
	}
	if c != nil && (c.Big == nil || c.Big.Size != t.size || c.Big.Action != fmt.Sprintf("%x", t.action)) {
		return "client log has no put of the handlers archive"
	}
	if mode == "dedupe" && (c == nil || !c.Big.Dedupe) {
		return "dedupe mode did not skip the body"
	}
	return ""
}

func portivoCommit(src string) string {
	b, err := os.ReadFile(filepath.Join(src, "..", "..", "PORTIVO_COMMIT"))
	if err != nil {
		return "unknown commit"
	}
	return strings.TrimSpace(string(b))[:10]
}

func goVersion() string {
	out, _ := exec.Command("/opt/homebrew/bin/go", "env", "GOVERSION").Output()
	return strings.TrimSpace(string(out))
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "e2e: "+format+"\n", a...)
	os.Exit(1)
}
