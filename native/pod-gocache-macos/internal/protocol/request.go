// Package protocol speaks the GOCACHEPROG wire format
// (cmd/go/internal/cacheprog) without reflection on the hot path: a streaming
// request reader with a fixed buffer, a base64 body stream decoded straight
// into the caller's buffer, and a response writer that appends into a reused
// buffer.
package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
)

// HashSize is the size of an action or output ID (cmd/go/internal/cache.HashSize).
const HashSize = 32

// Cmd is a request command.
type Cmd uint8

const (
	CmdUnknown Cmd = iota
	CmdGet
	CmdPut
	CmdClose
)

// KnownCommands is what the client declares in its first message.
var KnownCommands = []string{"get", "put", "close"}

// Request is one decoded request. IDs are valid only when their Has flag is set:
// the go command always sends 32-byte IDs, anything else is treated as absent.
type Request struct {
	ID          int64
	Command     Cmd
	HasActionID bool
	ActionID    [HashSize]byte
	HasOutputID bool
	OutputID    [HashSize]byte
	BodySize    int64
}

// ErrMalformedBody reports a put body that is not a well-formed base64 JSON
// string of exactly BodySize bytes.
var ErrMalformedBody = errors.New("pod-gocache: malformed put body")

// maxLine bounds a request line; longer lines are skipped without buffering.
const maxLine = 64 << 10

// Reader reads requests from the go command's stream.
type Reader struct {
	r          io.Reader
	buf        []byte
	start, end int
	eof        bool
	readErr    error
	beforeRead func()
	body       Body
}

// NewReader returns a Reader with a fixed buffer of size bytes (at least
// 2*maxLine). beforeRead runs before every read that may block, so buffered
// responses can be flushed first.
func NewReader(r io.Reader, size int, beforeRead func()) *Reader {
	if size < 2*maxLine {
		size = 2 * maxLine
	}
	rd := &Reader{r: r, buf: make([]byte, size), beforeRead: beforeRead}
	rd.body.r = rd
	return rd
}

// fill reads more input after compacting the buffer. It reports false at EOF
// or on a read error.
func (r *Reader) fill() bool {
	if r.eof {
		return false
	}
	if r.start > 0 {
		r.end = copy(r.buf, r.buf[r.start:r.end])
		r.start = 0
	}
	if r.end == len(r.buf) {
		return true
	}
	if r.beforeRead != nil {
		r.beforeRead()
	}
	for {
		n, err := r.r.Read(r.buf[r.end:])
		r.end += n
		if err != nil {
			r.eof = true
			if err != io.EOF {
				r.readErr = err
			}
			return n > 0
		}
		if n > 0 {
			return true
		}
	}
}

func (r *Reader) err() error {
	if r.readErr != nil {
		return r.readErr
	}
	return io.EOF
}

// Next reads the next request into req, first discarding whatever is left of
// the previous request's body. Lines that are not requests are skipped. It
// returns io.EOF when the input ends.
func (r *Reader) Next(req *Request) error {
	if r.body.state != bodyDone {
		r.body.Discard()
	}
	for {
		line, ok := r.line()
		if !ok {
			return r.err()
		}
		line = bytes.TrimRight(line, " \t\r")
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		if !parseFast(line, req) && !parseSlow(line, req) {
			continue
		}
		r.body.reset(req.BodySize)
		return nil
	}
}

// line returns the next line without its newline. Overlong lines are dropped.
func (r *Reader) line() ([]byte, bool) {
	for {
		if i := bytes.IndexByte(r.buf[r.start:r.end], '\n'); i >= 0 {
			line := r.buf[r.start : r.start+i]
			r.start += i + 1
			return line, true
		}
		if r.end-r.start >= maxLine {
			r.skipLine()
			continue
		}
		if !r.fill() {
			if r.start < r.end {
				line := r.buf[r.start:r.end]
				r.start = r.end
				return line, true
			}
			return nil, false
		}
	}
}

// skipLine discards input through the next newline.
func (r *Reader) skipLine() {
	for {
		if i := bytes.IndexByte(r.buf[r.start:r.end], '\n'); i >= 0 {
			r.start += i + 1
			return
		}
		r.start = r.end
		if !r.fill() {
			return
		}
	}
}

// Body returns the body of the request last returned by Next. It is empty
// when BodySize is not positive. It is valid until the next call to Next.
func (r *Reader) Body() *Body { return &r.body }

// parseFast accepts exactly the shape encoding/json produces for
// cacheprog.Request; anything else goes to parseSlow.
func parseFast(line []byte, req *Request) bool {
	*req = Request{}
	p := line
	var ok bool
	if p, ok = cut(p, `{"ID":`); !ok {
		return false
	}
	if req.ID, p, ok = parseInt(p); !ok {
		return false
	}
	if p, ok = cut(p, `,"Command":"`); !ok {
		return false
	}
	var cmd []byte
	if cmd, p, ok = plainString(p); !ok {
		return false
	}
	req.Command = command(cmd)
	if q, ok := cut(p, `,"ActionID":"`); ok {
		var s []byte
		if s, p, ok = plainString(q); !ok {
			return false
		}
		if req.HasActionID, ok = decodeID(s, &req.ActionID); !ok {
			return false
		}
	}
	if q, ok := cut(p, `,"OutputID":"`); ok {
		var s []byte
		if s, p, ok = plainString(q); !ok {
			return false
		}
		if req.HasOutputID, ok = decodeID(s, &req.OutputID); !ok {
			return false
		}
	}
	if q, ok := cut(p, `,"BodySize":`); ok {
		if req.BodySize, p, ok = parseInt(q); !ok {
			return false
		}
	}
	return len(p) == 1 && p[0] == '}'
}

func cut(p []byte, prefix string) ([]byte, bool) {
	if len(p) < len(prefix) || string(p[:len(prefix)]) != prefix {
		return p, false
	}
	return p[len(prefix):], true
}

// parseInt parses a JSON integer that fits in int64: no leading zeros, no
// fraction or exponent.
func parseInt(p []byte) (int64, []byte, bool) {
	i, neg := 0, false
	if i < len(p) && p[i] == '-' {
		neg = true
		i++
	}
	startDigits := i
	var u uint64
	for i < len(p) && p[i] >= '0' && p[i] <= '9' {
		if u > (1<<63)/10 {
			return 0, p, false
		}
		u = u*10 + uint64(p[i]-'0')
		if u > 1<<63 {
			return 0, p, false
		}
		i++
	}
	n := i - startDigits
	if n == 0 || (n > 1 && p[startDigits] == '0') {
		return 0, p, false
	}
	if i < len(p) && (p[i] == '.' || p[i] == 'e' || p[i] == 'E') {
		return 0, p, false
	}
	if !neg && u == 1<<63 {
		return 0, p, false
	}
	v := int64(u)
	if neg {
		v = -v
	}
	return v, p[i:], true
}

// plainString returns the bytes up to the closing quote, rejecting escapes and
// control characters (encoding/json would treat those differently).
func plainString(p []byte) (s, rest []byte, ok bool) {
	for i, c := range p {
		switch {
		case c == '"':
			return p[:i], p[i+1:], true
		case c == '\\' || c < 0x20:
			return nil, p, false
		}
	}
	return nil, p, false
}

func command(b []byte) Cmd {
	switch string(b) {
	case "get":
		return CmdGet
	case "put":
		return CmdPut
	case "close":
		return CmdClose
	}
	return CmdUnknown
}

// decodeID decodes a base64 ID. ok is false for invalid base64 (the caller
// then defers to encoding/json); has is true only for exactly 32 bytes.
func decodeID(s []byte, dst *[HashSize]byte) (has, ok bool) {
	if base64.StdEncoding.DecodedLen(len(s)) > HashSize+1 {
		return false, false
	}
	var tmp [HashSize + 1]byte
	n, err := base64.StdEncoding.Decode(tmp[:], s)
	if err != nil {
		return false, false
	}
	if n != HashSize {
		return false, true
	}
	copy(dst[:], tmp[:HashSize])
	return true, true
}

// jsonRequest mirrors cacheprog.Request; IDs stay raw so a bad ID does not
// lose the request's ID.
type jsonRequest struct {
	ID       int64
	Command  string
	ActionID json.RawMessage
	OutputID json.RawMessage
	BodySize int64
}

// parseSlow decodes any line encoding/json accepts as a request.
func parseSlow(line []byte, req *Request) bool {
	*req = Request{}
	var j jsonRequest
	if err := json.Unmarshal(line, &j); err != nil {
		return false
	}
	req.ID = j.ID
	req.Command = command([]byte(j.Command))
	req.HasActionID = rawID(j.ActionID, &req.ActionID)
	req.HasOutputID = rawID(j.OutputID, &req.OutputID)
	req.BodySize = j.BodySize
	return true
}

func rawID(raw json.RawMessage, dst *[HashSize]byte) bool {
	if len(raw) == 0 {
		return false
	}
	var b []byte
	if err := json.Unmarshal(raw, &b); err != nil || len(b) != HashSize {
		return false
	}
	copy(dst[:], b)
	return true
}
