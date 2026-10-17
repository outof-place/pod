package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"testing"
)

func seedLines(f *testing.F) {
	a := base64.StdEncoding.EncodeToString(id(1))
	for _, s := range []string{
		`{"ID":1,"Command":"get","ActionID":"` + a + `"}`,
		`{"ID":2,"Command":"put","ActionID":"` + a + `","OutputID":"` + a + `","BodySize":12}`,
		`{"ID":3,"Command":"put","ActionID":"` + a + `","OutputID":"` + a + `"}`,
		`{"ID":4,"Command":"close"}`,
		`{"ID":-0,"Command":"get"}`,
		`{"ID":01,"Command":"get"}`,
		`{"ID":9223372036854775807,"Command":"get"}`,
		`{"ID":9223372036854775808,"Command":"get"}`,
		`{"ID":-9223372036854775808,"Command":"get"}`,
		`{"ID":1,"Command":"get"}`,
		`{"ID":1,"Command":"get","ActionID":"AA=="}`,
		`{"ID":1,"Command":"get","ActionID":""}`,
		`{"ID":1,"Command":"get","ActionID":null}`,
		`{"ID":1.0,"Command":"get"}`,
		`{"ID":1,"Command":"get","BodySize":1e3}`,
		`{"ID":1,"Command":"get","ActionID":"` + a + `","ActionID":"AA=="}`,
		`{"ID":1,"Command":"\xff"}`,
	} {
		f.Add([]byte(s))
	}
}

// FuzzParseFast: whatever the fast path accepts, encoding/json (the go
// command's own encoder's inverse) reads identically.
func FuzzParseFast(f *testing.F) {
	seedLines(f)
	f.Fuzz(func(t *testing.T, line []byte) {
		var req Request
		if !parseFast(line, &req) {
			return
		}
		var g goRequest
		if err := json.Unmarshal(line, &g); err != nil {
			t.Fatalf("fast path accepted %q, encoding/json rejects it: %v", line, err)
		}
		if g.ID != req.ID || command([]byte(g.Command)) != req.Command || g.BodySize != req.BodySize {
			t.Fatalf("%q: fast %+v, json %+v", line, req, g)
		}
		check := func(name string, b []byte, has bool, got [HashSize]byte) {
			if (len(b) == HashSize) != has || (has && !bytes.Equal(b, got[:])) {
				t.Fatalf("%q: %s fast has=%v %x, json %x", line, name, has, got, b)
			}
		}
		check("ActionID", g.ActionID, req.HasActionID, req.ActionID)
		check("OutputID", g.OutputID, req.HasOutputID, req.OutputID)
	})
}

// FuzzReader feeds arbitrary streams: the reader never panics, always ends,
// and never reports more body bytes than announced.
func FuzzReader(f *testing.F) {
	seedLines(f)
	var in bytes.Buffer
	encodeLikeGo(f, &in, goRequest{ID: 1, Command: "put", ActionID: id(1), OutputID: id(2), BodySize: 5}, []byte("abcde"))
	encodeLikeGo(f, &in, goRequest{ID: 2, Command: "get", ActionID: id(3)}, nil)
	f.Add(in.Bytes())
	f.Add([]byte("{\"ID\":1,\"Command\":\"put\",\"BodySize\":3}\n\n\"YWJj\"\n{\"ID\":2}\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		r := NewReader(bytes.NewReader(data), 0, nil)
		buf := make([]byte, 7)
		var req Request
		for i := 0; ; i++ {
			if i > len(data)+1 {
				t.Fatalf("no progress after %d requests", i)
			}
			if err := r.Next(&req); err != nil {
				return
			}
			if req.BodySize <= 0 || i%2 == 1 {
				continue // odd requests leave the body to Next
			}
			var total int64
			for {
				n, err := r.Body().Read(buf)
				total += int64(n)
				if total > req.BodySize {
					t.Fatalf("read %d of a %d-byte body", total, req.BodySize)
				}
				if err != nil {
					if err == io.EOF && total != req.BodySize {
						t.Fatalf("EOF after %d of %d bytes", total, req.BodySize)
					}
					break
				}
			}
		}
	})
}

// FuzzBodyRoundTrip: any body, any input chunking, any read size decodes to
// the original bytes.
func FuzzBodyRoundTrip(f *testing.F) {
	f.Add([]byte("x"), uint8(1), uint8(1))
	f.Add([]byte("hello, world"), uint8(3), uint8(2))
	f.Add(bytes.Repeat([]byte{0}, 1000), uint8(255), uint8(7))
	f.Fuzz(func(t *testing.T, body []byte, chunk, readSize uint8) {
		if len(body) == 0 {
			return
		}
		var in bytes.Buffer
		encodeLikeGo(t, &in, goRequest{ID: 1, Command: "put", ActionID: id(1), OutputID: id(2), BodySize: int64(len(body))}, body)
		encodeLikeGo(t, &in, goRequest{ID: 2, Command: "close"}, nil)
		r := NewReader(&chunkReader{data: in.Bytes(), n: int(chunk%64) + 1}, 0, nil)
		var req Request
		if err := r.Next(&req); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, int(readSize%32)+1)
		var got []byte
		for {
			n, err := r.Body().Read(buf)
			got = append(got, buf[:n]...)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		if !bytes.Equal(got, body) {
			t.Fatalf("decoded %d bytes, want %d", len(got), len(body))
		}
		if err := r.Next(&req); err != nil || req.ID != 2 {
			t.Fatalf("next: %v %+v", err, req)
		}
	})
}

// chunkReader returns at most n bytes per Read.
type chunkReader struct {
	data []byte
	n    int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p[:min(len(p), c.n)], c.data)
	c.data = c.data[n:]
	return n, nil
}
