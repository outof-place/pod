package protocol

import (
	"bytes"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"
)

// goResponse is cacheprog.Response as the go command decodes it.
type goResponse struct {
	ID            int64
	Err           string     `json:",omitempty"`
	KnownCommands []string   `json:",omitempty"`
	Miss          bool       `json:",omitempty"`
	OutputID      []byte     `json:",omitempty"`
	Size          int64      `json:",omitempty"`
	Time          *time.Time `json:",omitempty"`
	DiskPath      string     `json:",omitempty"`
}

// decodeAll reads responses the way (*ProgCache).readLoop does.
func decodeAll(t *testing.T, data []byte) []goResponse {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	var out []goResponse
	for dec.More() {
		var r goResponse
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("go would fail decoding %q: %v", data, err)
		}
		out = append(out, r)
	}
	return out
}

func TestResponsesDecodeAsGoExpects(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	out := [HashSize]byte(id(0x7f))
	when := time.Date(2026, 10, 17, 12, 34, 56, 123456789, time.UTC)
	path := "/tmp/we\"ird\\path\n\x01/żółw/ x-d"
	w.Hello()
	w.Hit(41, &out, 1<<40, when.UnixNano(), []byte(path))
	w.Miss(42)
	w.Put(43, []byte("/c/ab/ab-d"))
	w.Done(44)
	w.Error(45, `bad "thing"`)
	w.Hit(46, &out, 0, 0, []byte("/zero"))
	w.Flush()

	rs := decodeAll(t, buf.Bytes())
	if len(rs) != 7 {
		t.Fatalf("got %d responses", len(rs))
	}
	if rs[0].ID != 0 || len(rs[0].KnownCommands) != 3 || rs[0].KnownCommands[0] != "get" || rs[0].KnownCommands[1] != "put" || rs[0].KnownCommands[2] != "close" {
		t.Errorf("hello: %+v", rs[0])
	}
	h := rs[1]
	if h.ID != 41 || h.Miss || !bytes.Equal(h.OutputID, out[:]) || h.Size != 1<<40 || h.DiskPath != path || h.Time == nil || !h.Time.Equal(when) {
		t.Errorf("hit: %+v", h)
	}
	if rs[2].ID != 42 || !rs[2].Miss || rs[2].DiskPath != "" {
		t.Errorf("miss: %+v", rs[2])
	}
	if rs[3].ID != 43 || rs[3].DiskPath != "/c/ab/ab-d" || rs[3].Err != "" {
		t.Errorf("put: %+v", rs[3])
	}
	if rs[4].ID != 44 || rs[4].Err != "" {
		t.Errorf("close: %+v", rs[4])
	}
	if rs[5].ID != 45 || rs[5].Err != `bad "thing"` {
		t.Errorf("error: %+v", rs[5])
	}
	if rs[6].Time == nil || rs[6].Time.UnixNano() != 0 || rs[6].Size != 0 {
		t.Errorf("zero hit: %+v", rs[6])
	}
}

// Responses wait in the buffer until Flush (or a full buffer).
func TestWriterBuffersUntilFlush(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	w.Miss(1)
	if buf.Len() != 0 {
		t.Fatalf("wrote before Flush: %q", buf.String())
	}
	w.Flush()
	if buf.String() != `{"ID":1,"Miss":true}`+"\n" {
		t.Fatalf("got %q", buf.String())
	}
	for i := range 2000 {
		w.Miss(int64(i))
	}
	if buf.Len() < flushAt {
		t.Fatalf("a full buffer was not written: %d bytes out", buf.Len())
	}
}

// Later stages answer some requests from other goroutines, out of order:
// concurrent responses never interleave and each arrives once.
func TestWriterConcurrentOutOfOrder(t *testing.T) {
	var buf lockedBuffer
	w := NewWriter(&buf)
	out := [HashSize]byte(id(3))
	var wg sync.WaitGroup
	const workers, each = 8, 500
	for g := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range each {
				n := int64(g*each + i + 1)
				if n%2 == 0 {
					w.Hit(n, &out, n, n, []byte("/p/"+strconv.FormatInt(n, 10)))
				} else {
					w.Miss(n)
				}
				if i%7 == 0 {
					w.Flush()
				}
			}
		}()
	}
	wg.Wait()
	w.Flush()
	seen := map[int64]bool{}
	for _, r := range decodeAll(t, buf.Bytes()) {
		if seen[r.ID] {
			t.Fatalf("ID %d answered twice", r.ID)
		}
		seen[r.ID] = true
		if r.ID%2 == 0 && (r.Miss || r.DiskPath != "/p/"+strconv.FormatInt(r.ID, 10) || r.Size != r.ID) {
			t.Fatalf("hit %d corrupted: %+v", r.ID, r)
		}
		if r.ID%2 == 1 && !r.Miss {
			t.Fatalf("miss %d corrupted: %+v", r.ID, r)
		}
	}
	if len(seen) != workers*each {
		t.Fatalf("%d responses, want %d", len(seen), workers*each)
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}
