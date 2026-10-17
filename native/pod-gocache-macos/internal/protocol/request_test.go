package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

// goRequest is cacheprog.Request as the go command declares it, so
// encoding/json produces the exact bytes go sends.
type goRequest struct {
	ID       int64
	Command  string
	ActionID []byte    `json:",omitempty"`
	OutputID []byte    `json:",omitempty"`
	Body     io.Reader `json:"-"`
	BodySize int64     `json:",omitempty"`
}

// encodeLikeGo mirrors (*ProgCache).writeToChild in cmd/go/internal/cache/prog.go.
func encodeLikeGo(t testing.TB, w io.Writer, req goRequest, body []byte) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(req); err != nil {
		t.Fatal(err)
	}
	io.WriteString(w, "\n")
	if req.BodySize > 0 {
		io.WriteString(w, `"`)
		e := base64.NewEncoder(base64.StdEncoding, w)
		e.Write(body)
		e.Close()
		io.WriteString(w, "\"\n")
	}
}

func id(b byte) []byte { return bytes.Repeat([]byte{b}, HashSize) }

func TestReaderDecodesGoRequests(t *testing.T) {
	var in bytes.Buffer
	body := []byte("hello, cache")
	out := sha256.Sum256(body)
	encodeLikeGo(t, &in, goRequest{ID: 1, Command: "get", ActionID: id(0xaa)}, nil)
	encodeLikeGo(t, &in, goRequest{ID: 2, Command: "put", ActionID: id(0xbb), OutputID: out[:], BodySize: int64(len(body))}, body)
	encodeLikeGo(t, &in, goRequest{ID: 3, Command: "put", ActionID: id(0xcc), OutputID: id(0xdd)}, nil)
	encodeLikeGo(t, &in, goRequest{ID: 4, Command: "close"}, nil)

	r := NewReader(iotest.OneByteReader(&in), 0, nil)
	var req Request
	next := func() Request {
		t.Helper()
		if err := r.Next(&req); err != nil {
			t.Fatalf("Next: %v", err)
		}
		return req
	}
	if got := next(); got.ID != 1 || got.Command != CmdGet || !got.HasActionID || got.ActionID != [HashSize]byte(id(0xaa)) {
		t.Fatalf("get: %+v", got)
	}
	got := next()
	if got.ID != 2 || got.Command != CmdPut || got.BodySize != int64(len(body)) || got.OutputID != out || got.ActionID != [HashSize]byte(id(0xbb)) {
		t.Fatalf("put: %+v", got)
	}
	data, err := io.ReadAll(r.Body())
	if err != nil || string(data) != string(body) {
		t.Fatalf("body = %q, %v", data, err)
	}
	if got := next(); got.ID != 3 || got.Command != CmdPut || got.BodySize != 0 || !got.HasOutputID {
		t.Fatalf("empty put: %+v", got)
	}
	if got := next(); got.ID != 4 || got.Command != CmdClose {
		t.Fatalf("close: %+v", got)
	}
	if err := r.Next(&req); err != io.EOF {
		t.Fatalf("after close: %v", err)
	}
}

// An unread body is skipped by Next, at any size and read granularity.
func TestReaderSkipsUnreadBodies(t *testing.T) {
	for _, size := range []int{1, 2, 3, 4, 100, 64 << 10, 300 << 10, 1<<20 + 7} {
		var in bytes.Buffer
		body := bytes.Repeat([]byte{0xa5, 0x5a, 0x00}, size/3+1)[:size]
		encodeLikeGo(t, &in, goRequest{ID: 1, Command: "put", ActionID: id(1), OutputID: id(2), BodySize: int64(size)}, body)
		encodeLikeGo(t, &in, goRequest{ID: 2, Command: "get", ActionID: id(3)}, nil)
		r := NewReader(iotest.HalfReader(&in), 0, nil)
		var req Request
		if err := r.Next(&req); err != nil || req.ID != 1 {
			t.Fatalf("size %d: first: %v %+v", size, err, req)
		}
		if err := r.Next(&req); err != nil || req.ID != 2 {
			t.Fatalf("size %d: after skipped body: %v %+v", size, err, req)
		}
	}
}

// Every read size, down to one byte, yields the exact body.
func TestBodyReadSizes(t *testing.T) {
	for _, size := range []int{1, 2, 3, 4, 5, 6, 7, 1000, 1001, 1002} {
		body := make([]byte, size)
		for i := range body {
			body[i] = byte(i*7 + 3)
		}
		for _, chunk := range []int{1, 2, 3, 4, 5, 64, 4096} {
			var in bytes.Buffer
			encodeLikeGo(t, &in, goRequest{ID: 9, Command: "put", ActionID: id(1), OutputID: id(2), BodySize: int64(size)}, body)
			r := NewReader(iotest.OneByteReader(&in), 0, nil)
			var req Request
			if err := r.Next(&req); err != nil {
				t.Fatal(err)
			}
			var got []byte
			buf := make([]byte, chunk)
			for {
				n, err := r.Body().Read(buf)
				got = append(got, buf[:n]...)
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatalf("size %d chunk %d: %v", size, chunk, err)
				}
			}
			if !bytes.Equal(got, body) {
				t.Fatalf("size %d chunk %d: got %d bytes, mismatch", size, chunk, len(got))
			}
		}
	}
}

// Malformed bodies fail, and the next request is still read. Discard checks
// only the framing (length and closing quote), so a well-framed body with bad
// content is skipped without error.
func TestBodyMalformed(t *testing.T) {
	framedOK := map[string]bool{"short": true, "bad char": true, "inner pad": true}
	const next = `{"ID":7,"Command":"close"}` + "\n"
	cases := map[string]string{
		"short":        `"aGVsbG8="` + "\n",     // 5 bytes, BodySize says 6
		"long":         `"aGVsbG8hIQ=="` + "\n", // 7 bytes
		"bad char":     `"aGV*bG8h"` + "\n",
		"no quote":     next,
		"newline":      "\"aGVs\nbG8h\"\n",
		"inner pad":    `"aG==bG8h"` + "\n",
		"open no data": `"` + "\n",
	}
	for name, bodyLine := range cases {
		in := `{"ID":1,"Command":"put","ActionID":"` + base64.StdEncoding.EncodeToString(id(1)) + `","OutputID":"` + base64.StdEncoding.EncodeToString(id(2)) + `","BodySize":6}` + "\n\n" + bodyLine
		if name != "no quote" {
			in += next
		}
		for _, discard := range []bool{false, true} {
			r := NewReader(strings.NewReader(in), 0, nil)
			var req Request
			if err := r.Next(&req); err != nil {
				t.Fatal(err)
			}
			var err error
			if discard {
				err = r.Body().Discard()
			} else {
				_, err = io.ReadAll(r.Body())
			}
			if wantErr := !discard || !framedOK[name]; (err != nil) != wantErr {
				t.Errorf("%s (discard=%v): err = %v, want error %v", name, discard, err, wantErr)
			}
			if err := r.Next(&req); err != nil || req.ID != 7 {
				t.Errorf("%s (discard=%v): next request: %v %+v", name, discard, err, req)
			}
		}
	}
}

func TestBodyTruncated(t *testing.T) {
	in := `{"ID":1,"Command":"put","ActionID":"` + base64.StdEncoding.EncodeToString(id(1)) + `","OutputID":"` + base64.StdEncoding.EncodeToString(id(2)) + `","BodySize":6}` + "\n\n\"aGVs"
	r := NewReader(strings.NewReader(in), 0, nil)
	var req Request
	if err := r.Next(&req); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(r.Body()); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("err = %v", err)
	}
	if err := r.Next(&req); err != io.EOF {
		t.Fatalf("Next = %v", err)
	}
}

// Lines that are not requests are skipped; requests encoding/json accepts in
// other shapes are still understood.
func TestReaderTolerance(t *testing.T) {
	a := base64.StdEncoding.EncodeToString(id(5))
	in := strings.Join([]string{
		"garbage",
		`{"ID":`,
		"\"aGVsbG8=\"",
		strings.Repeat("x", 3*maxLine),
		`{"Command":"get","ID":11,"ActionID":"` + a + `"}`,
		`{ "id" : 12 , "command" : "get" , "actionid" : "` + a + `" , "Extra": [1, {"x": null}] }`,
		`{"ID":13,"Command":"get","ActionID":"c2hvcnQ="}`,
		`{"ID":14,"Command":"get","ActionID":"!!!"}`,
		`{"ID":15,"Command":"get2","ActionID":"` + a + `"}` + "\r",
		`{"ID":16,"Command":"close"}`,
	}, "\n")
	r := NewReader(strings.NewReader(in), 0, nil)
	want := []struct {
		id  int64
		cmd Cmd
		has bool
	}{{11, CmdGet, true}, {12, CmdGet, true}, {13, CmdGet, false}, {14, CmdGet, false}, {15, CmdUnknown, true}, {16, CmdClose, false}}
	for _, w := range want {
		var req Request
		if err := r.Next(&req); err != nil {
			t.Fatalf("want ID %d: %v", w.id, err)
		}
		if req.ID != w.id || req.Command != w.cmd || req.HasActionID != w.has {
			t.Fatalf("got %+v, want %+v", req, w)
		}
		if w.has && req.ActionID != [HashSize]byte(id(5)) {
			t.Fatalf("ID %d: wrong ActionID", req.ID)
		}
	}
}

// beforeRead runs before the reader blocks, so queued responses go out
// before the client waits for more input.
func TestBeforeReadRunsBeforeBlocking(t *testing.T) {
	pr, pw := io.Pipe()
	calls := make(chan int, 16)
	n := 0
	r := NewReader(pr, 0, func() { n++; calls <- n })
	go func() {
		io.WriteString(pw, `{"ID":1,"Command":"close"}`+"\n")
		<-calls // the second fill happens only after the first request was consumed
		pw.Close()
	}()
	var req Request
	if err := r.Next(&req); err != nil || req.ID != 1 {
		t.Fatalf("Next: %v %+v", err, req)
	}
	if err := r.Next(&req); err != io.EOF {
		t.Fatalf("Next: %v", err)
	}
	if n < 2 {
		t.Fatalf("beforeRead ran %d times", n)
	}
}
