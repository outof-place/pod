// Command passprog is a minimal GOCACHEPROG client used as a measuring instrument in S0:
// Go's native GOCACHE layout, direct disk, no daemon, one request at a time. It logs when
// each request arrives and is answered, so go's own share of a put can be told apart.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"

	"pod-gocache-macos/bench/internal/nativecache"
	"pod-gocache-macos/bench/internal/proglog"
)

// nonce is set with -ldflags=-X by cmd/execcost so each fresh binary has a new code hash.
var nonce = "dev"

type request struct {
	ID       int64
	Command  string
	ActionID []byte `json:",omitempty"`
	OutputID []byte `json:",omitempty"`
	BodySize int64  `json:",omitempty"`
}

type response struct {
	ID            int64
	Err           string     `json:",omitempty"`
	KnownCommands []string   `json:",omitempty"`
	Miss          bool       `json:",omitempty"`
	OutputID      []byte     `json:",omitempty"`
	Size          int64      `json:",omitempty"`
	Time          *time.Time `json:",omitempty"`
	DiskPath      string     `json:",omitempty"`
}

type client struct {
	dir     string
	decoder string
	write   string
	put     string
	echo    bool
	in      *inbuf
	out     *os.File
	mu      sync.Mutex // guards out and events once get workers run
	events  []proglog.Event
	jobs    chan getJob
	pending sync.WaitGroup
}

type getJob struct {
	req request
	ev  proglog.Event
}

func main() {
	start := time.Now().UnixNano()
	dir := flag.String("dir", "", "GOCACHE directory in Go's native layout")
	decoder := flag.String("decoder", "neon", "base64 decoder for put bodies: neon or stdlib")
	write := flag.String("write", "pwrite", "how put bodies reach disk: pwrite or mmap")
	put := flag.String("put", "decode", "decode: always write the body; dedupe: skip it when -d already exists")
	logPath := flag.String("log", "", "append JSONL request timings here")
	bufSize := flag.Int("buf", 1<<20, "stdin read buffer bytes")
	echo := flag.Bool("echo", false, "answer every get with a miss without touching disk (transport floor for cmd/getrtt)")
	workers := flag.Int("workers", 1, "goroutines answering gets; 1 answers every request in order on the read loop")
	flag.Parse()
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "passprog: -dir is required")
		os.Exit(2)
	}
	c := &client{dir: *dir, decoder: *decoder, write: *write, put: *put, echo: *echo,
		in: &inbuf{f: os.Stdin, buf: make([]byte, *bufSize)}, out: os.Stdout}
	if *workers > 1 {
		c.jobs = make(chan getJob, 1024)
		for i := 0; i < *workers; i++ {
			go func() {
				for j := range c.jobs {
					c.finish(c.get(&j.req, &j.ev), &j.ev)
					c.pending.Done()
				}
			}()
		}
	}
	c.respond(&response{KnownCommands: []string{"get", "put", "close"}})
	ready := time.Now().UnixNano()
	err := c.serve()
	if *logPath != "" {
		c.writeLog(*logPath, proglog.Summary{Summary: true, Nonce: nonce, Main: start, Ready: ready,
			Decoder: *decoder, Write: *write, Put: *put})
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "passprog:", err)
		os.Exit(1)
	}
}

func (c *client) serve() error {
	for {
		line, err := c.in.line()
		if err != nil {
			c.pending.Wait()
			return nil // stdin closed: go is gone or done
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue // go writes an extra newline after every request object
		}
		recv := time.Now().UnixNano()
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			return fmt.Errorf("bad request line: %v", err)
		}
		ev := proglog.Event{ID: req.ID, Cmd: req.Command, Recv: recv}
		var res *response
		switch req.Command {
		case "get":
			if c.jobs != nil {
				c.pending.Add(1)
				c.jobs <- getJob{req: req, ev: ev}
				continue
			}
			res = c.get(&req, &ev)
		case "put":
			res, err = c.putReq(&req, &ev)
			if err != nil {
				return err
			}
		case "close":
			c.pending.Wait() // answer close only after every get it follows
			res = &response{}
		default:
			res = &response{Err: "unknown command " + req.Command}
		}
		c.finish(res, &ev)
		if req.Command == "close" {
			return nil
		}
	}
}

func (c *client) get(req *request, ev *proglog.Event) *response {
	if c.echo {
		return &response{Miss: true}
	}
	ev.Action = fmt.Sprintf("%x", req.ActionID)
	e, err := nativecache.ReadEntry(c.dir, req.ActionID)
	if err != nil {
		return &response{Miss: true}
	}
	path := nativecache.FileName(c.dir, e.OutputID, "d")
	if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() || st.Size() != e.Size {
		return &response{Miss: true}
	}
	ev.Hit = true
	ev.Size = e.Size
	ev.Output = fmt.Sprintf("%x", e.OutputID)
	return &response{OutputID: e.OutputID, Size: e.Size, Time: &e.Time, DiskPath: path}
}

func (c *client) finish(res *response, ev *proglog.Event) {
	res.ID = ev.ID
	c.mu.Lock()
	c.respond(res)
	ev.Done = time.Now().UnixNano()
	c.events = append(c.events, *ev)
	c.mu.Unlock()
}

func (c *client) respond(res *response) {
	b, err := json.Marshal(res)
	if err != nil {
		panic(err)
	}
	b = append(b, '\n')
	if _, err := c.out.Write(b); err != nil {
		os.Exit(1) // go closed our stdout; nothing left to answer
	}
}

func (c *client) writeLog(path string, s proglog.Summary) {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	s.Exit = time.Now().UnixNano()
	s.UserS = float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6
	s.SysS = float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
	s.MaxRSSMB = float64(ru.Maxrss) / (1 << 20) // bytes on darwin
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for i := range c.events {
		enc.Encode(&c.events[i])
	}
	enc.Encode(&s)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "passprog: log:", err)
		return
	}
	f.Write(buf.Bytes())
	f.Close()
}
