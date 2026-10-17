// Package fakego is the go command's side of GOCACHEPROG for tests: requests
// framed byte for byte like (*ProgCache).writeToChild and responses read like
// its readLoop (Go 1.27.2 cmd/go/internal/cache/prog.go, BSD-licensed,
// Copyright 2023 The Go Authors), including its fatal conditions, which it
// reports as errors.
package fakego

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// Request is cacheprog.Request.
type Request struct {
	ID       int64
	Command  string
	ActionID []byte    `json:",omitempty"`
	OutputID []byte    `json:",omitempty"`
	Body     io.Reader `json:"-"`
	BodySize int64     `json:",omitempty"`
}

// Response is cacheprog.Response.
type Response struct {
	ID            int64
	Err           string     `json:",omitempty"`
	KnownCommands []string   `json:",omitempty"`
	Miss          bool       `json:",omitempty"`
	OutputID      []byte     `json:",omitempty"`
	Size          int64      `json:",omitempty"`
	Time          *time.Time `json:",omitempty"`
	DiskPath      string     `json:",omitempty"`
}

// Conn talks to one cache program.
type Conn struct {
	stdin io.WriteCloser
	bw    *bufio.Writer
	jenc  *json.Encoder

	closing  atomic.Bool
	readDone chan struct{}

	mu       sync.Mutex
	nextID   int64
	inFlight map[int64]chan *Response
	fatal    error // what would make go exit: early EOF, bad JSON, unknown ID

	writeMu sync.Mutex

	Known []string
}

// ErrClosed is errCacheprogClosed.
var ErrClosed = errors.New("GOCACHEPROG program closed unexpectedly")

// Start waits up to timeout for the capabilities message.
func Start(stdout io.Reader, stdin io.WriteCloser, timeout time.Duration) (*Conn, error) {
	c := &Conn{
		stdin:    stdin,
		bw:       bufio.NewWriter(stdin),
		readDone: make(chan struct{}),
		inFlight: map[int64]chan *Response{},
	}
	c.jenc = json.NewEncoder(c.bw)
	capc := make(chan *Response, 1)
	c.inFlight[0] = capc
	go c.readLoop(stdout)
	select {
	case res := <-capc:
		if res == nil || len(res.KnownCommands) == 0 {
			return nil, fmt.Errorf("declared no supported commands: %v", c.Fatal())
		}
		c.Known = res.KnownCommands
		return c, nil
	case <-time.After(timeout):
		return nil, errors.New("no capabilities message")
	}
}

func (c *Conn) readLoop(stdout io.Reader) {
	defer close(c.readDone)
	jd := json.NewDecoder(stdout)
	for {
		res := new(Response)
		if err := jd.Decode(res); err != nil {
			c.mu.Lock()
			if !c.closing.Load() {
				if err == io.EOF {
					c.fatal = fmt.Errorf("GOCACHEPROG exited pre-Close with %v pending requests", len(c.inFlight))
				} else {
					c.fatal = fmt.Errorf("error reading JSON from GOCACHEPROG: %v", err)
				}
			}
			for _, ch := range c.inFlight {
				close(ch)
			}
			c.inFlight = nil
			c.mu.Unlock()
			return
		}
		c.mu.Lock()
		ch, ok := c.inFlight[res.ID]
		delete(c.inFlight, res.ID)
		if !ok && c.fatal == nil {
			c.fatal = fmt.Errorf("GOCACHEPROG sent response for unknown request ID %v", res.ID)
		}
		c.mu.Unlock()
		if ok {
			ch <- res
		}
	}
}

// Fatal is the first condition that would have made go exit.
func (c *Conn) Fatal() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fatal
}

func (c *Conn) send(req *Request) (*Response, error) {
	resc := make(chan *Response, 1)
	if err := c.writeToChild(req, resc); err != nil {
		return nil, err
	}
	res := <-resc
	if res == nil {
		return nil, ErrClosed
	}
	if res.Err != "" {
		return res, errors.New(res.Err)
	}
	return res, nil
}

func (c *Conn) writeToChild(req *Request, resc chan *Response) error {
	c.mu.Lock()
	if c.inFlight == nil {
		c.mu.Unlock()
		return ErrClosed
	}
	c.nextID++
	req.ID = c.nextID
	c.inFlight[req.ID] = resc
	c.mu.Unlock()

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.jenc.Encode(req); err != nil {
		return err
	}
	if err := c.bw.WriteByte('\n'); err != nil {
		return err
	}
	if req.Body != nil && req.BodySize > 0 {
		c.bw.WriteByte('"')
		e := base64.NewEncoder(base64.StdEncoding, c.bw)
		if _, err := io.Copy(e, req.Body); err != nil {
			return err
		}
		e.Close()
		c.bw.WriteString("\"\n")
	}
	return c.bw.Flush()
}

// Get sends a get.
func (c *Conn) Get(actionID []byte) (*Response, error) {
	return c.send(&Request{Command: "get", ActionID: actionID})
}

// Put sends a put of body, with its SHA-256 as the output ID.
func (c *Conn) Put(actionID, body []byte) (*Response, error) {
	out := sha256.Sum256(body)
	return c.send(&Request{Command: "put", ActionID: actionID, OutputID: out[:], Body: bytesReader(body), BodySize: int64(len(body))})
}

// PutStream sends a put whose body comes from r.
func (c *Conn) PutStream(actionID, outputID []byte, size int64, r io.Reader) (*Response, error) {
	return c.send(&Request{Command: "put", ActionID: actionID, OutputID: outputID, Body: r, BodySize: size})
}

func bytesReader(b []byte) io.Reader {
	if len(b) == 0 {
		return nil
	}
	return &sliceReader{b: b}
}

type sliceReader struct{ b []byte }

func (r *sliceReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

// WriteRaw writes bytes to the program's stdin between requests.
func (c *Conn) WriteRaw(b []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.bw.Write(b); err != nil {
		return err
	}
	return c.bw.Flush()
}

// Close is (*ProgCache).Close: close request, then stdin closes, then wait
// for the program to close its stdout.
func (c *Conn) Close() error {
	c.closing.Store(true)
	_, err := c.send(&Request{Command: "close"})
	if errors.Is(err, ErrClosed) {
		err = nil
	}
	c.stdin.Close()
	<-c.readDone
	return err
}

// Done is closed when the program's stdout ends.
func (c *Conn) Done() <-chan struct{} { return c.readDone }
