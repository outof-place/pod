// Command getrtt replays the get requests of a real warm build, one at a time, against passprog
// over pipes (framed exactly like cmd/go/internal/cache/prog.go) and against an in-process copy
// of the built-in DiskCache lookup. The difference per get is the client's added latency.
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"pod-gocache-macos/bench/internal/machstate"
	"pod-gocache-macos/bench/internal/nativecache"
	"pod-gocache-macos/bench/internal/proglog"
	"pod-gocache-macos/bench/internal/stats"
)

type request struct {
	ID       int64
	Command  string
	ActionID []byte `json:",omitempty"`
}

type response struct {
	ID            int64
	Err           string
	KnownCommands []string
	Miss          bool
	DiskPath      string
}

// progConn mirrors ProgCache: a JSON encoder on a 4 KiB bufio writer, an extra newline and a
// flush per request, and a read loop that hands responses to waiters by ID.
type progConn struct {
	cmd    *exec.Cmd
	bw     *bufio.Writer
	jenc   *json.Encoder
	stdin  io.WriteCloser
	mu     sync.Mutex
	nextID int64
	wait   map[int64]chan *response
}

func startProg(prog, dir string, extra ...string) *progConn {
	cmd := exec.Command(prog, append([]string{"-dir", dir}, extra...)...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		fatal("%v", err)
	}
	c := &progConn{cmd: cmd, stdin: stdin, bw: bufio.NewWriter(stdin), wait: map[int64]chan *response{0: make(chan *response, 1)}}
	c.jenc = json.NewEncoder(c.bw)
	go func() {
		jd := json.NewDecoder(stdout)
		for {
			res := new(response)
			if err := jd.Decode(res); err != nil {
				return
			}
			c.mu.Lock()
			ch := c.wait[res.ID]
			delete(c.wait, res.ID)
			c.mu.Unlock()
			ch <- res
		}
	}()
	<-c.wait[0]
	return c
}

func (c *progConn) send(req *request) *response {
	ch := make(chan *response, 1)
	c.mu.Lock()
	c.nextID++
	req.ID = c.nextID
	c.wait[req.ID] = ch
	c.mu.Unlock()
	c.jenc.Encode(req)
	c.bw.WriteByte('\n')
	c.bw.Flush()
	return <-ch
}

func (c *progConn) close() {
	c.send(&request{Command: "close"})
	c.stdin.Close()
	c.cmd.Wait()
}

// builtinGet is DiskCache.get plus OutputFile: read and parse -a, stat -a (markUsed), stat -d.
func builtinGet(dir string, id []byte) bool {
	e, err := nativecache.ReadEntry(dir, id)
	if err != nil {
		return false
	}
	os.Stat(nativecache.FileName(dir, id, "a"))
	_, err = os.Stat(nativecache.FileName(dir, e.OutputID, "d"))
	return err == nil
}

// startPgc starts pod-gocache's client the way go does: "prog", the store in GOCACHE.
func startPgc(bin, dir string, env ...string) *progConn {
	cmd := exec.Command(bin, "prog")
	cmd.Env = append(append(os.Environ(), "GOCACHE="+dir), env...)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		fatal("%v", err)
	}
	c := &progConn{cmd: cmd, stdin: stdin, bw: bufio.NewWriter(stdin), wait: map[int64]chan *response{0: make(chan *response, 1)}}
	c.jenc = json.NewEncoder(c.bw)
	go func() {
		jd := json.NewDecoder(stdout)
		for {
			res := new(response)
			if err := jd.Decode(res); err != nil {
				return
			}
			c.mu.Lock()
			ch := c.wait[res.ID]
			delete(c.wait, res.ID)
			c.mu.Unlock()
			ch <- res
		}
	}()
	<-c.wait[0]
	return c
}

// side is one way of answering the replayed gets.
type side struct {
	name   string
	before func()
	open   func() (get func(id []byte) bool, done func())
	us     []float64
	sums   []float64
	hits   int
}

func main() {
	dir := flag.String("dir", "/tmp/podgc-s0/gocache", "GOCACHE clone")
	prog := flag.String("prog", "/tmp/podgc-s0/bin/passprog", "passprog binary (S0's client and the -echo floor)")
	pgc := flag.String("pgc", "", "pod-gocache binary: adds S1 (shared state off) and S9 (fast path) sides")
	live := flag.String("live", "", "POD_GOCACHE_LIVE_DIR of the daemon publishing for -dir")
	daemonPID := flag.Int("daemon-pid", 0, "the publishing daemon: SIGSTOPped for the stale-index side")
	traceDir := flag.String("trace", "/tmp/podgc-s0/getrtt-trace", "POD_GOCACHE_TRACE_DIR for pod-gocache")
	sides := flag.String("sides", "builtin,passprog,echo", "comma-separated: builtin, passprog, echo, s1, s9, s9-stale")
	logPath := flag.String("log", "", "passprog log of a warm run; its gets are replayed")
	reps := flag.Int("reps", 5, "replays per side, interleaved; the first round is a warm-up")
	flag.Parse()
	procs, err := proglog.Read(*logPath)
	if err != nil || len(procs) == 0 {
		fatal("read %s: %v", *logPath, err)
	}
	var ids [][]byte
	for _, p := range procs {
		for _, e := range p.Events {
			if e.Cmd == "get" {
				id, _ := hex.DecodeString(e.Action)
				ids = append(ids, id)
			}
		}
	}
	over := func(c *progConn) (func([]byte) bool, func()) {
		return func(id []byte) bool { return !c.send(&request{Command: "get", ActionID: id}).Miss }, c.close
	}
	all := map[string]*side{
		"builtin": {name: "built-in DiskCache lookup, in process", open: func() (func([]byte) bool, func()) {
			return func(id []byte) bool { return builtinGet(*dir, id) }, func() {}
		}},
		"passprog": {name: "S0 passprog over pipes", open: func() (func([]byte) bool, func()) { return over(startProg(*prog, *dir)) }},
		"echo":     {name: "transport floor: passprog -echo, a miss without disk", open: func() (func([]byte) bool, func()) { return over(startProg(*prog, *dir, "-echo")) }},
		"s1": {name: "pod-gocache, shared state off (S1)", open: func() (func([]byte) bool, func()) {
			return over(startPgc(*pgc, *dir, "POD_GOCACHE_LIVE=off", "POD_GOCACHE_TRACE_DIR="+*traceDir))
		}},
		"s9": {name: "pod-gocache, fast path (S9)", open: func() (func([]byte) bool, func()) {
			return over(startPgc(*pgc, *dir, "POD_GOCACHE_LIVE_DIR="+*live, "POD_GOCACHE_TRACE_DIR="+*traceDir))
		}},
		// Every -a rewritten in place (new ctime) while the daemon is stopped: each
		// lookup finds the index stale and reads the -a, the worst case for S9.
		"s9-stale": {name: "pod-gocache, index stale, daemon stopped", before: func() { stale(*dir, ids, *daemonPID, true) }, open: func() (func([]byte) bool, func()) {
			c := startPgc(*pgc, *dir, "POD_GOCACHE_LIVE_DIR="+*live, "POD_GOCACHE_TRACE_DIR="+*traceDir)
			get, done := over(c)
			return get, func() { done(); stale(*dir, nil, *daemonPID, false) }
		}},
	}
	var order []*side
	for _, n := range strings.Split(*sides, ",") {
		s := all[n]
		if s == nil {
			fatal("unknown side %q", n)
		}
		order = append(order, s)
	}
	fmt.Printf("## get round trip, %d gets from %s\n\n%s\n\nBefore: %s\n\n", len(ids), *logPath, machstate.Header(), machstate.Take())
	var loads []float64
	for r := 0; r <= *reps; r++ {
		for k := range order {
			s := order[(k+r)%len(order)]
			if s.before != nil {
				s.before()
			}
			loads = append(loads, machstate.Take().Load1)
			get, done := s.open()
			var sum float64
			for _, id := range ids {
				t0 := time.Now()
				hit := get(id)
				us := float64(time.Since(t0).Nanoseconds()) / 1e3
				if r > 0 {
					s.us = append(s.us, us)
					if hit {
						s.hits++
					}
				}
				sum += us
			}
			done()
			if r > 0 {
				s.sums = append(s.sums, sum/1e3)
			}
		}
	}
	fmt.Printf("| side | gets timed | hits | p50 us | p90 us | p99 us | mean us | sum per replay ms: median [min..max] IQR |\n|---|---|---|---|---|---|---|---|\n")
	for _, s := range order {
		st := stats.Summarize(s.us)
		fmt.Printf("| %s | %d | %d | %.1f | %.1f | %.1f | %.1f | %s |\n", s.name, len(s.us), s.hits, st.Median, stats.Quantile(s.us, 0.9),
			stats.Quantile(s.us, 0.99), st.Mean, stats.Summarize(s.sums).Format("%.1f"))
	}
	if b, s9, s1 := all["builtin"], all["s9"], all["s1"]; len(s9.sums) > 0 {
		paired := func(a, b *side) string {
			var d []float64
			for i := range min(len(a.sums), len(b.sums)) {
				d = append(d, a.sums[i]-b.sums[i])
			}
			return stats.Summarize(d).Format("%+.1f")
		}
		fmt.Printf("\nPaired per replay (same round), ms: S9 minus built-in %s; S9 minus S1 %s\n", paired(s9, b), paired(s9, s1))
	}
	fmt.Printf("\nLoad1 at each replay start: %s. After: %s\n", stats.Summarize(loads).Format("%.1f"), machstate.Take())
}

// stale rewrites the times of every replayed -a (its ctime changes, the index
// entry no longer matches) with the daemon stopped, or resumes the daemon.
func stale(dir string, ids [][]byte, pid int, stop bool) {
	if pid == 0 {
		fatal("-daemon-pid is required for the stale side")
	}
	if !stop {
		syscall.Kill(pid, syscall.SIGCONT)
		time.Sleep(3 * time.Second) // the daemon re-reads and republishes
		return
	}
	syscall.Kill(pid, syscall.SIGSTOP)
	for _, id := range ids {
		p := nativecache.FileName(dir, id, "a")
		if fi, err := os.Stat(p); err == nil {
			os.Chtimes(p, fi.ModTime(), fi.ModTime())
		}
	}
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "getrtt: "+format+"\n", a...)
	os.Exit(1)
}
