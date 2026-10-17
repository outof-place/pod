package protocol

import (
	"bytes"
	"io"
	"testing"
)

// repeatReader returns the same request forever.
type repeatReader struct{ line []byte }

func (r *repeatReader) Read(p []byte) (int, error) {
	n := 0
	for n+len(r.line) <= len(p) {
		n += copy(p[n:], r.line)
	}
	return n, nil
}

// Reading a get and answering it allocates nothing.
func TestGetRoundTripAllocations(t *testing.T) {
	var in bytes.Buffer
	encodeLikeGo(t, &in, goRequest{ID: 123456, Command: "get", ActionID: id(9)}, nil)
	r := NewReader(&repeatReader{line: in.Bytes()}, 0, nil)
	w := NewWriter(io.Discard)
	var req Request
	out := [HashSize]byte(id(1))
	path := []byte("/Users/someone/Library/Caches/go-build/01/0101010101010101010101010101010101010101010101010101010101010101-d")
	allocs := testing.AllocsPerRun(10000, func() {
		if err := r.Next(&req); err != nil || req.Command != CmdGet {
			t.Fatal(err)
		}
		w.Hit(req.ID, &out, 12345, 1792245446101594250, path)
		w.Miss(req.ID)
		w.Flush()
	})
	if allocs != 0 {
		t.Fatalf("%v allocations per get", allocs)
	}
}
