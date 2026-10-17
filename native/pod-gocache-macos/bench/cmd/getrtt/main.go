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
	"sync"
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

func main() {
	dir := flag.String("dir", "/tmp/podgc-s0/gocache", "GOCACHE clone")
	prog := flag.String("prog", "/tmp/podgc-s0/bin/passprog", "passprog binary")
	logPath := flag.String("log", "", "passprog log of a warm run; its gets are replayed")
	reps := flag.Int("reps", 5, "replays per side, interleaved; the first pair is a warm-up")
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
	fmt.Printf("## get round trip, %d gets from %s\n\n%s\n\nBefore: %s\n\n", len(ids), *logPath, machstate.Header(), machstate.Take())
	var clientUS, builtinUS, clientSum, builtinSum, echoUS, echoSum []float64
	hitsC, hitsB := 0, 0
	for r := 0; r <= *reps; r++ {
		c := startProg(*prog, *dir)
		var sum float64
		for _, id := range ids {
			t0 := time.Now()
			res := c.send(&request{Command: "get", ActionID: id})
			us := float64(time.Since(t0).Nanoseconds()) / 1e3
			if r > 0 {
				clientUS = append(clientUS, us)
				if !res.Miss {
					hitsC++
				}
			}
			sum += us
		}
		c.close()
		if r > 0 {
			clientSum = append(clientSum, sum/1e3)
		}
		sum = 0
		for _, id := range ids {
			t0 := time.Now()
			hit := builtinGet(*dir, id)
			us := float64(time.Since(t0).Nanoseconds()) / 1e3
			if r > 0 {
				builtinUS = append(builtinUS, us)
				if hit {
					hitsB++
				}
			}
			sum += us
		}
		if r > 0 {
			builtinSum = append(builtinSum, sum/1e3)
		}
		e := startProg(*prog, *dir, "-echo")
		sum = 0
		for _, id := range ids {
			t0 := time.Now()
			e.send(&request{Command: "get", ActionID: id})
			us := float64(time.Since(t0).Nanoseconds()) / 1e3
			if r > 0 {
				echoUS = append(echoUS, us)
			}
			sum += us
		}
		e.close()
		if r > 0 {
			echoSum = append(echoSum, sum/1e3)
		}
	}
	row := func(name string, us, sums []float64, hits int) {
		s := stats.Summarize(us)
		fmt.Printf("| %s | %d | %.1f | %.1f | %.1f | %.1f | %s |\n", name, len(us), s.Median, stats.Quantile(us, 0.9),
			stats.Quantile(us, 0.99), s.Mean, stats.Summarize(sums).Format("%.1f"))
		_ = hits
	}
	fmt.Printf("| path | gets timed | p50 us | p90 us | p99 us | mean us | sum per replay ms: median [min..max] IQR |\n|---|---|---|---|---|---|---|\n")
	row("passprog over pipes (cmd/go framing)", clientUS, clientSum, hitsC)
	row("built-in DiskCache lookup, in process", builtinUS, builtinSum, hitsB)
	row("transport floor: passprog -echo answers a miss without disk", echoUS, echoSum, 0)
	fmt.Printf("\nHits: passprog %d, built-in %d (of %d timed gets each). After: %s\n", hitsC, hitsB, len(clientUS), machstate.Take())
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "getrtt: "+format+"\n", a...)
	os.Exit(1)
}
